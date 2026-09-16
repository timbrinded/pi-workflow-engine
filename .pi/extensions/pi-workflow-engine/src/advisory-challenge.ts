import { Type, type Static } from "typebox";
import { collectAdvisoryStage, type AdvisoryStageCoverage } from "./advisory-evidence.ts";
import { DEFAULT_ADVISORY_TOOLS, DEFAULT_ADVISORY_TOOL_HINTS, type AdvisoryVerified } from "./workflow-advisory-utils.ts";
import type { WorkflowApi } from "./types.ts";

const ChallengeSchema = Type.Object({
  outcome: Type.Union([Type.Literal("counterexample"), Type.Literal("alternative-explanation"), Type.Literal("supports-original"), Type.Literal("no-counterexample")]),
  evidence: Type.Array(Type.String()),
  experiment: Type.String({ description: "Smallest distinguishing experiment, with observed result if actually run." }),
});
const AdjudicationSchema = Type.Object({
  outcome: Type.Union([Type.Literal("upheld"), Type.Literal("refuted"), Type.Literal("unresolved")]),
  evidence: Type.Array(Type.String()),
  reason: Type.String(),
});
export type ChallengeRecord =
  | { status: "complete"; challenge: Static<typeof ChallengeSchema>; adjudication: Static<typeof AdjudicationSchema> }
  | { status: "failed"; challenge?: Static<typeof ChallengeSchema> };
export interface AdvisoryChallengeOptions {
  maxChallenges: number;
  shouldChallenge?: (finding: AdvisoryVerified) => boolean;
}

/** Opt in with --challenge or --challenge=N (hard bound of 10). */
export function parseChallengeArgs(args: string): { args: string; options: AdvisoryChallengeOptions } {
  let maxChallenges = 0;
  const remaining = args.replace(/(?:^|\s)--challenge(?:=([^\s]*))?(?=\s|$)/g, (_match, limit: string | undefined) => {
    if (limit !== undefined && !/^\d+$/.test(limit)) {
      throw new Error(`Invalid --challenge value "${limit}". Use --challenge or --challenge=N with a non-negative integer; zero disables challenges.`);
    }
    maxChallenges = Math.min(10, limit === undefined ? 3 : Number(limit));
    return " ";
  });
  return { args: remaining.trim(), options: { maxChallenges } };
}

export function needsChallenge(finding: AdvisoryVerified): boolean {
  return finding.verdict === "PLAUSIBLE" || finding.verdict === "NOT_SUBSTANTIATED" || finding.evidence.length === 0 ||
    /\b(security|concurren\w*|race|persist\w*|cancel\w*|retr(?:y|ies)|data loss|corrupt\w*|high impact)\b/i.test(`${finding.category} ${finding.summary} ${finding.impact}`);
}

/** A bounded recipe using existing agent/parallel calls, not a new runtime primitive. */
export async function challengeFindings<T extends AdvisoryVerified>(
  api: Pick<WorkflowApi, "agent" | "parallel">,
  findings: T[],
  context: string,
  options: AdvisoryChallengeOptions,
  coverage: AdvisoryStageCoverage[],
): Promise<T[]> {
  const limit = Number.isFinite(options.maxChallenges) ? Math.max(0, Math.min(10, Math.trunc(options.maxChallenges))) : 0;
  if (limit === 0) return findings;
  const selected = findings.filter((finding) => finding.verdict !== "REFUTED" && (options.shouldChallenge ?? needsChallenge)(finding)).slice(0, limit);
  const replacements = new Map<string, T>();
  await collectAdvisoryStage(api, "Challenge", selected.map((finding) => ({ id: finding.candidateId, run: async () => {
    // Preserve the candidate as unresolved if either independent stage fails.
    replacements.set(finding.candidateId, { ...finding, verdict: "NOT_SUBSTANTIATED", challenge: { status: "failed" } });
    const challenge = await api.agent(
      `Assume this finding is a false positive. Try to DISPROVE it. Find the strongest concrete counterexample or alternative root cause. Inspect callers, invariants, tests and control flow. For a repair, seek an input, race or error path that still fails. State the smallest experiment distinguishing explanations. Do not edit files or claim tests you did not run. No counterexample found is not proof.\n\nExact review context:\n${context}\n\nCandidate and verifier evidence:\n${JSON.stringify(finding)}`,
      { label: `challenge:${finding.candidateId}`, phase: "Challenge", profile: "medium", tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS, schema: ChallengeSchema },
    );
    replacements.set(finding.candidateId, { ...finding, verdict: "NOT_SUBSTANTIATED", challenge: { status: "failed", challenge } });
    const adjudication = await api.agent(
      `Adjudicate the original finding, independent verifier evidence and falsification attempt below. Preserve unresolved conflict; do not force consensus. A missing counterexample alone cannot upgrade a plausible claim. Cite concrete evidence and observed test results; never invent experiments.\nContext:\n${context}\nOriginal and verifier:\n${JSON.stringify(finding)}\nChallenger:\n${JSON.stringify(challenge)}`,
      { label: `adjudicate:${finding.candidateId}`, phase: "Challenge", profile: "medium", tools: [], schema: AdjudicationSchema },
    );
    replacements.set(finding.candidateId, {
      ...finding,
      verdict: adjudication.outcome === "refuted" ? "REFUTED" : adjudication.outcome === "unresolved" ? "NOT_SUBSTANTIATED" : finding.verdict,
      evidence: [...finding.evidence, ...challenge.evidence, ...(challenge.experiment ? [challenge.experiment] : []), ...adjudication.evidence, adjudication.reason],
      challenge: { status: "complete", challenge, adjudication },
    });
    return finding.candidateId;
  } })), coverage);
  return findings.map((finding) => replacements.get(finding.candidateId) ?? finding);
}
