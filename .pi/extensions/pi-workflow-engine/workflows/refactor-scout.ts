import { challengeFindings, parseChallengeArgs } from "../src/advisory-challenge.ts";
import { Type } from "typebox";
import {
  type AdvisoryVerified,
  type AdvisoryLens,
  synthesizeAdvisoryReport,
  finishAdvisoryReport,
  emptyAdvisoryReport,
  formatEvidence,
  formatLocation,
  publishVerifiedKeptProgress,
  runLensVerificationPipeline,
  DEFAULT_ADVISORY_TOOL_HINTS,
  DEFAULT_ADVISORY_TOOLS,
} from "../src/workflow-advisory-utils.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "refactor-scout",
  description: "Advisory-only refactor scout: scope → per-lens find → independent verify → synthesize safe refactor opportunities.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Challenge" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  target: Type.String({ description: "Verbatim target path, module, or focus area being scouted." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files in scope." }),
  summary: Type.String({ description: "One-paragraph summary of the scoped code." }),
  conventions: Type.Optional(Type.String({ description: "Relevant project conventions from AGENTS.md / docs." })),
});

const REFACTOR_LENSES: AdvisoryLens[] = [
  { label: "duplication", category: "duplication", text: "Repeated logic, copy-pasted structures, or near-duplicate flows that could share one clearer implementation." },
  { label: "complexity", category: "complexity", text: "Oversized functions, tangled control flow, or abstractions that make local reasoning harder than necessary." },
  { label: "type-safety", category: "type-safety", text: "Weak typing, avoidable casts, unchecked shapes, or places stronger types would prevent mistakes." },
  { label: "boundaries", category: "boundary", text: "Leaky module boundaries, misplaced responsibilities, or imports that couple unrelated layers." },
  { label: "dead-code", category: "dead-code", text: "Unused, obsolete, or redundant code paths that can likely be removed safely." },
  { label: "conventions", category: "conventions", text: "Departures from project conventions, naming, dependency rules, or local idioms." },
];

const PER_LENS = 5;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, phase, log, progress, args } = api;
  const challengeConfig = parseChallengeArgs(args);
  const target = challengeConfig.args.trim() || ".";
  let fileCount = 0;
  let rawCandidateCount = 0;
  let droppedCandidateCount = 0;
  let refutedCandidateCount = 0;
  const makeStats = (verified: number, kept: number): WorkflowRunStats => ({
    files: fileCount,
    candidates: rawCandidateCount,
    verified,
    kept,
    dropped: droppedCandidateCount,
    refuted: refutedCandidateCount,
  });

  phase("Scope");
  const scope = await agent(
    "Establish the scope for an advisory-only refactor scout. Do not edit files.\n" +
      `Target / focus (verbatim): ${target}\n\n` +
      "Inspect repository structure, the target path or module, and relevant AGENTS.md / project docs conventions. " +
      "Return the concrete files that should be considered, a short summary, and any conventions that affect refactor advice. " +
      `This workflow will fan out across ${REFACTOR_LENSES.length} lenses with up to ${PER_LENS} candidates per lens. Structured output only.`,
    { phase: "Scope", label: "scope", tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS, profile: "medium", schema: ScopeSchema },
  );

  if (!scope || scope.files.length === 0) {
    return finishAdvisoryReport(emptyAdvisoryReport(
      "No files were identified for refactor scouting.",
      ["Provide a target path, module, or subsystem to scout for refactor opportunities."],
      makeStats(0, 0),
    ), []);
  }

  fileCount = scope.files.length;
  progress({ type: "counter", key: "files", label: "files", value: fileCount });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") });
  log(`${scope.files.length} files scoped for refactor scouting`);

  const scopeBlock =
    `## Target\n${scope.target}\n\n## Files in scope\n${scope.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Summary\n${scope.summary}\n\n## Conventions\n${scope.conventions ?? "(none noted)"}\n` +
    (args.trim() ? `\n## User instructions (verbatim)\n${args.trim()}\n` : "");

  const pipelineResult = await runLensVerificationPipeline({
    api,
    lenses: REFACTOR_LENSES,
    perLens: PER_LENS,
    finderPrompt: (lens) =>
      `## Refactor-scout finder — ${lens.label}\n\n${scopeBlock}\n` +
      "This workflow is advisory-only: do not edit files and do not propose broad rewrites.\n" +
      `Scout through ONLY this lens:\n${lens.text}\n\n` +
      `Surface up to ${PER_LENS} candidates. Use category exactly "${lens.category}". ` +
      "Each candidate must include a one-line summary, locations, impact on maintainability or future correctness, and an optional safe first recommendation. " +
      "Only include opportunities where a small, reviewable first step is plausible. Structured output only.",
    verifierPrompt: (candidate) =>
      `## Refactor-scout verifier\n\n${scopeBlock}\n## Candidate\n` +
      `Location: ${formatLocation(candidate)}\nCategory: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}\n` +
      `Recommendation: ${candidate.recommendation ?? "(none supplied)"}\n\n` +
      "Read the relevant files and return CONFIRMED, PLAUSIBLE, NOT_SUBSTANTIATED, or REFUTED. " +
      "Default toward REFUTED if the opportunity is generic, too broad, not evidenced by code, or lacks a safe first step. " +
      "Evidence must quote or cite code. Structured output only.",
  });
  rawCandidateCount += pipelineResult.rawCandidates;
  droppedCandidateCount += pipelineResult.dropped;
  refutedCandidateCount += pipelineResult.refuted;
  const { coverage } = pipelineResult;
  const verified = await challengeFindings(api, pipelineResult.verified, scopeBlock, challengeConfig.options, coverage);
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  publishVerifiedKeptProgress({ progress, log }, verified.length, surviving.length);

  if (surviving.length === 0) {
    return finishAdvisoryReport(emptyAdvisoryReport("No refactor opportunities survived verification.", ["Leave the scoped code unchanged unless a human reviewer has additional context."], stats), coverage, verified);
  }

  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] IDs: ${finding.sourceCandidateIds.join(", ")} ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nSafe first step: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");

  const resolved = await synthesizeAdvisoryReport(api,
    `## Synthesis: final refactor-scout report\n\n${ranked.length} opportunities survived independent verification.\n\n${block}\n\n` +
      "Merge findings with the same root cause and rank highest leverage / lowest risk first. " +
      "Select findings by ID. " +
      "Severity is maintenance or future-correctness impact. " +
      "Recommendations must be safe first refactor steps, not rewrites. Include concrete nextSteps for the host developer. Structured output only.",
    ranked, coverage,
  );
  return finishAdvisoryReport({ ...resolved, stats: { ...stats, kept: resolved.findings.length } }, coverage, verified);
}

function rank(finding: AdvisoryVerified): number {
  const verdictRank = finding.verdict === "CONFIRMED" ? 0 : 1;
  const categoryRank = finding.category === "dead-code" || finding.category === "conventions" ? 2 : 0;
  return verdictRank + categoryRank;
}
