import { Type } from "typebox";
import {
  AdvisoryCandidatesSchema,
  AdvisoryReportSchema,
  AdvisoryVerdictSchema,
  type AdvisoryCandidate,
  type AdvisoryReport,
  type AdvisoryVerdict,
} from "../src/advisory-schema.ts";
import {
  advisoryDedupKey as dedupKey,
  backfillAdvisoryFindings,
  formatEvidence,
  formatLocation,
  primaryLocation,
  recordVerdictProgress,
  DEFAULT_ADVISORY_TOOL_HINTS,
  DEFAULT_ADVISORY_TOOLS,
} from "../src/workflow-advisory-utils.ts";
import { compactResults } from "../src/concurrency.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "diagnose",
  description: "Advisory-only bug diagnosis: scope symptoms → competing hypotheses → independent verify → synthesize likely root causes.",
  phases: [{ title: "Scope" }, { title: "Hypothesize" }, { title: "Verify" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  symptom: Type.String({ description: "Observed bug, failing command, regression, or unclear behavior." }),
  commands: Type.Array(Type.String(), { description: "Safe read-only or diagnostic commands relevant to the symptom." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files likely involved." }),
  observations: Type.Array(Type.String(), { description: "Concrete observations from files, tests, config, or command output." }),
  constraints: Type.Optional(Type.String({ description: "Safety constraints, missing evidence, or commands intentionally not run." })),
});

interface HypothesisLens {
  label: string;
  category: string;
  text: string;
}

type Candidate = AdvisoryCandidate;

interface Hypothesis extends Candidate {
  lens: HypothesisLens;
}

interface Verified extends Hypothesis {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
}

const HYPOTHESIS_LENSES: HypothesisLens[] = [
  { label: "recent-change", category: "regression", text: "A recent code change broke a previously working path or changed an implicit contract." },
  { label: "control-flow", category: "root-cause", text: "Incorrect branching, ordering, async flow, data flow, or state transition causes the symptom." },
  { label: "configuration", category: "configuration", text: "Configuration, environment, package scripts, or runtime assumptions differ from what the code expects." },
  { label: "dependency-api", category: "dependency", text: "A dependency API, version, import mode, or bundled peer behavior does not match the implementation." },
  { label: "test-fixture", category: "test-fixture", text: "The failure is caused by test setup, fixtures, mocks, generated files, or stale local state rather than product code." },
];

const TOOLS = DEFAULT_ADVISORY_TOOLS;
const TOOL_HINTS = DEFAULT_ADVISORY_TOOL_HINTS;
const PER_LENS = 4;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, parallel, phase, log, progress, args } = api;
  const symptom = args.trim();
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
    "Establish the scope for an advisory-only diagnosis workflow. Do not edit files.\n" +
      (symptom
        ? `Bug / failure description (verbatim): ${symptom}\n\n`
        : "No explicit symptom was provided. Infer likely failing commands from repository manifests and scripts without running destructive commands.\n\n") +
      "Inspect relevant files, package/test configuration, and safe diagnostic commands. " +
      "Safe commands are read-only commands such as status, grep, listing files, typecheck/test commands, or commands explicitly requested by the user. " +
      "Do not run mutation, install, commit, network, or destructive commands. Return scoped files, observations, and constraints. Structured output only.",
    { phase: "Scope", label: "scope", tools: TOOLS, toolHints: TOOL_HINTS, thinkingLevel: "medium", schema: ScopeSchema },
  );

  if (!scope) {
    return emptyReport(
      "Diagnosis could not establish a scope.",
      ["Provide the failing command, error message, or regression description and rerun diagnose."],
      makeStats(0, 0),
    );
  }

  fileCount = scope.files.length;
  progress({ type: "counter", key: "files", label: "files", value: fileCount });
  progress({ type: "summary", key: "symptom", value: scope.symptom });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") || "(none)" });
  log(`${scope.files.length} files scoped for diagnosis`);

  const scopeBlock =
    `## Symptom\n${scope.symptom}\n\n## Relevant commands\n${scope.commands.map((command) => `- ${command}`).join("\n") || "(none)"}\n\n` +
    `## Files\n${scope.files.map((file) => `- ${file}`).join("\n") || "(none)"}\n\n` +
    `## Observations\n${scope.observations.map((observation) => `- ${observation}`).join("\n") || "(none)"}\n\n` +
    `## Constraints\n${scope.constraints ?? "(none noted)"}\n`;

  phase("Hypothesize");
  const perLens = await parallel(
    HYPOTHESIS_LENSES.map((lens) => async (): Promise<Hypothesis[]> => {
      const found = await agent(
        `## Diagnose hypothesis generator — ${lens.label}\n\n${scopeBlock}\n` +
          "This workflow is advisory-only: diagnose and recommend validation/fix plans, but do not edit files.\n" +
          `Consider ONLY this hypothesis lens:\n${lens.text}\n\n` +
          `Surface up to ${PER_LENS} root-cause hypotheses. Use category exactly "${lens.category}". ` +
          "Each hypothesis must include a one-line summary, locations, impact explaining how it produces the symptom, and an optional recommendation for the next validation step. Structured output only.",
        { phase: "Hypothesize", label: `hypothesize:${lens.label}`, tools: TOOLS, toolHints: TOOL_HINTS, thinkingLevel: "low", schema: AdvisoryCandidatesSchema },
      );
      const candidates = (found?.candidates ?? []).slice(0, PER_LENS).map((candidate) => ({ ...candidate, lens }));
      rawCandidateCount += candidates.length;
      progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: candidates.length });
      for (const candidate of candidates) {
        progress({
          type: "lane_item",
          lane: "Hypotheses",
          title: candidate.summary,
          subtitle: formatLocation(candidate),
          status: "pending",
          details: candidate.impact,
        });
      }
      return candidates;
    }),
  );

  const hypotheses = dedupe(compactResults(perLens).flat(), (dropped) => {
    droppedCandidateCount += dropped;
    progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: dropped });
  });

  phase("Verify");
  const verified = compactResults(
    await parallel(
      hypotheses.map((hypothesis) => async (): Promise<Verified | null> => {
        const location = primaryLocation(hypothesis);
        const judged = await agent(
          `## Diagnose verifier\n\n${scopeBlock}\n## Hypothesis\n` +
            `Location: ${formatLocation(hypothesis)}\nCategory: ${hypothesis.category}\nSummary: ${hypothesis.summary}\nImpact: ${hypothesis.impact}\n` +
            `Recommended validation: ${hypothesis.recommendation ?? "(none supplied)"}\n\n` +
            "Read relevant files and, when useful, run only safe read-only diagnostic commands from the scoped command list or commands explicitly requested by the user. " +
            "Do not run mutation, install, commit, network, or destructive commands. Return CONFIRMED, PLAUSIBLE, or REFUTED with evidence. " +
            "Default toward REFUTED if evidence does not connect the hypothesis to the symptom. Structured output only.",
          {
            phase: "Verify",
            label: `verify:${location.file.split("/").pop() ?? location.file}`,
            tools: TOOLS,
            toolHints: TOOL_HINTS,
            thinkingLevel: "low",
            schema: AdvisoryVerdictSchema,
          },
        );
        if (!judged) return null;
        recordVerdictProgress(progress, hypothesis, judged, () => {
          refutedCandidateCount += 1;
        });
        return { ...hypothesis, verdict: judged.verdict, evidence: judged.evidence, confidence: judged.confidence };
      }),
    ),
  );

  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const refuted = verified.filter((finding) => finding.verdict === "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  progress({ type: "counter", key: "verified", label: "verified", value: verified.length });
  progress({ type: "counter", key: "kept", label: "kept", value: surviving.length });
  progress({ type: "summary", key: "verified", value: verified.length });
  progress({ type: "summary", key: "kept", value: surviving.length });
  log(`${verified.length} verified → ${surviving.length} kept`);

  if (surviving.length === 0) {
    return emptyReport(
      "No root-cause hypothesis survived verification.",
      ["Capture the exact failing command and error output.", "Rerun diagnose with a narrower symptom or more evidence."],
      stats,
    );
  }

  phase("Synthesize");
  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nValidation/fix plan: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");
  const refutedBlock = refuted
    .slice(0, 8)
    .map((finding) => `- ${finding.summary} — REFUTED because ${formatEvidence(finding.evidence)}`)
    .join("\n");

  const report = await agent(
    `## Synthesis: final diagnosis report\n\n${ranked.length} hypotheses survived independent verification.\n\n${block}\n\n` +
      `## Refuted hypotheses for context\n${refutedBlock || "(none recorded)"}\n\n` +
      "Produce the shared advisory report shape. Only include confirmed or plausible root causes in findings. " +
      "Use categories such as root-cause, regression, configuration, dependency, or test-fixture. " +
      "Recommendation must be a validation/fix plan, not a patch. nextSteps must be the minimum commands or code inspections needed to confirm the top diagnosis. Structured output only.",
    {
      phase: "Synthesize",
      label: "synthesize",
      tools: [],
      thinkingLevel: "medium",
      resume: "read-only",
      schema: AdvisoryReportSchema,
    },
  );

  if (!report) return emptyReport("Synthesis produced no output.", ["Inspect verifier evidence manually or rerun diagnose with a narrower symptom."], stats);

  const findings = backfillAdvisoryFindings(report.findings, ranked, {
    impact: "Impact not restated by synthesis.",
    recommendation: "Validate this diagnosis with the smallest safe reproduction command.",
  });
  return { ...report, findings, stats };
}

function emptyReport(summary: string, nextSteps: string[], stats: WorkflowRunStats): AdvisoryReport & { stats: WorkflowRunStats } {
  return { summary, findings: [], nextSteps, stats };
}

function dedupe(candidates: Hypothesis[], onDropped: (dropped: number) => void): Hypothesis[] {
  const seen = new Set<string>();
  const novel: Hypothesis[] = [];
  for (const candidate of candidates) {
    const key = dedupKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    novel.push(candidate);
  }
  const dropped = candidates.length - novel.length;
  if (dropped > 0) onDropped(dropped);
  return novel;
}

function rank(finding: Verified): number {
  if (finding.verdict === "CONFIRMED") return 0;
  return 1;
}
