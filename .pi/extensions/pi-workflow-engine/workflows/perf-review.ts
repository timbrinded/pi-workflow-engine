import { challengeFindings, parseChallengeArgs } from "../src/advisory-challenge.ts";
import { type AdvisoryStageCoverage } from "../src/advisory-evidence.ts";
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
  name: "perf-review",
  description: "Advisory-only performance review: scope slow path → per-lens bottleneck hypotheses → verify evidence → synthesize measurements and safe optimizations.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Challenge" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  target: Type.String({ description: "Verbatim slow path, workload, command, or performance concern." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files likely involved in the performance path." }),
  commands: Type.Array(Type.String(), { description: "Existing benchmark, smoke, or measurement commands relevant to this path." }),
  summary: Type.String({ description: "One-paragraph summary of the performance-relevant path." }),
  knownMeasurements: Type.Optional(Type.String({ description: "Existing measurements, timings, or explicit lack of measurements." })),
});

const PERF_LENSES: AdvisoryLens[] = [
  { label: "algorithmic", category: "algorithmic", text: "Complexity, repeated scans, avoidable nested loops, or data-structure choices that grow poorly with input size." },
  { label: "io", category: "io", text: "Filesystem, subprocess, network, or other I/O costs on hot paths or startup paths." },
  { label: "concurrency", category: "concurrency", text: "Unnecessary serialization, missing batching, excessive fan-out, contention, or concurrency limits." },
  { label: "startup", category: "startup", text: "Import/module loading, initialization, discovery, or cold-start overhead." },
  { label: "allocation", category: "allocation", text: "Memory churn, large intermediate strings/objects, repeated serialization, or retained state growth." },
  { label: "measurement", category: "measurement", text: "Missing, misleading, noisy, or insufficient benchmark/measurement design." },
];

const TOOLS = DEFAULT_ADVISORY_TOOLS;
const TOOL_HINTS = DEFAULT_ADVISORY_TOOL_HINTS;
const PER_LENS = 4;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, phase, log, progress, args } = api;
  const challengeConfig = parseChallengeArgs(args);
  const target = challengeConfig.args.trim() || "repository performance";
  let fileCount = 0;
  let rawCandidateCount = 0;
  let droppedCandidateCount = 0;
  let refutedCandidateCount = 0;
  const coverage: AdvisoryStageCoverage[] = [];
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
    "Establish the scope for an advisory-only performance review. Do not edit files.\n" +
      `Performance target / concern (verbatim): ${target}\n\n` +
      "Inspect repository structure, scripts, likely hot-path files, and any existing benchmark or measurement commands. " +
      "Prefer identifying what to measure before claiming bottlenecks. Return files, commands, summary, and known measurements or the lack of them. " +
      `This workflow will fan out across ${PERF_LENSES.length} lenses with up to ${PER_LENS} candidates per lens. Structured output only.`,
    { phase: "Scope", label: "scope", tools: TOOLS, toolHints: TOOL_HINTS, profile: "medium", schema: ScopeSchema },
  );

  if (!scope || scope.files.length === 0) {
    return finishAdvisoryReport(emptyAdvisoryReport(
      "No performance-relevant files were identified.",
      ["Provide a slow command, workload, file path, or user-visible latency concern to review."],
      makeStats(0, 0),
    ), coverage);
  }

  fileCount = scope.files.length;
  progress({ type: "counter", key: "files", label: "files", value: fileCount });
  progress({ type: "summary", key: "target", value: scope.target });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") });
  log(`${scope.files.length} files scoped for performance review`);

  const scopeBlock =
    `## Target\n${scope.target}\n\n## Files\n${scope.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Measurement commands\n${scope.commands.map((command) => `- ${command}`).join("\n") || "(none identified)"}\n\n` +
    `## Summary\n${scope.summary}\n\n## Known measurements\n${scope.knownMeasurements ?? "(none known)"}\n` +
    (args.trim() ? `\n## User instructions (verbatim)\n${args.trim()}\n` : "");

  const pipelineResult = await runLensVerificationPipeline({
    api,
    lenses: PERF_LENSES,
    perLens: PER_LENS,
    finderPrompt: (lens) =>
      `## Perf-review finder — ${lens.label}\n\n${scopeBlock}\n` +
      "This workflow is advisory-only: identify bottleneck hypotheses, measurement gaps, and safe optimization directions, but do not edit files.\n" +
      `Investigate ONLY this lens:\n${lens.text}\n\n` +
      `Surface up to ${PER_LENS} candidates. Use category exactly "${lens.category}". ` +
      "Each candidate must include a one-line summary, locations, impact stating the suspected performance consequence and workload where it matters, " +
      "and an optional recommendation. Prefer measurement recommendations when evidence is weak. Structured output only.",
    verifierPrompt: (candidate) =>
      `## Perf-review verifier\n\n${scopeBlock}\n## Candidate\n` +
      `Location: ${formatLocation(candidate)}\nCategory: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}\n` +
      `Recommendation: ${candidate.recommendation ?? "(none supplied)"}\n\n` +
      "Read relevant files and package/scripts. Run only safe read-only measurement or inspection commands when useful. " +
      "Return CONFIRMED, PLAUSIBLE, NOT_SUBSTANTIATED, or REFUTED with evidence from code, scripts, config, or measurement output. " +
      "Default toward PLAUSIBLE or REFUTED when no measurement exists; do not overstate a bottleneck. Structured output only.",
  });
  rawCandidateCount += pipelineResult.rawCandidates;
  droppedCandidateCount += pipelineResult.dropped;
  refutedCandidateCount += pipelineResult.refuted;
  coverage.push(...pipelineResult.coverage);
  const verified = await challengeFindings(api, pipelineResult.verified, scopeBlock, challengeConfig.options, coverage);
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  publishVerifiedKeptProgress({ progress, log }, verified.length, surviving.length);

  if (surviving.length === 0) {
    return finishAdvisoryReport(emptyAdvisoryReport(
      "No performance finding survived verification.",
      ["Add or run a focused measurement for the target workload before optimizing.", "Rerun perf-review with benchmark output or a narrower slow path."],
      stats,
    ), coverage, verified);
  }

  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] IDs: ${finding.sourceCandidateIds.join(", ")} ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nRecommendation: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");

  const resolved = await synthesizeAdvisoryReport(api,
    `## Synthesis: final perf-review report\n\n${ranked.length} candidates survived independent verification.\n\n${block}\n\n` +
      "Select findings by ID. " +
      "Severity is expected performance impact for the target workload. Prefer measurement recommendations before optimization recommendations when evidence is weak. " +
      "Recommendations must be safe advisory next actions, not patches. Include risky optimizations to avoid in recommendations or nextSteps when relevant. Structured output only.",
    ranked, coverage,
  );
  return finishAdvisoryReport({ ...resolved, stats: { ...stats, kept: resolved.findings.length } }, coverage, verified);
}

function rank(finding: AdvisoryVerified): number {
  const verdictRank = finding.verdict === "CONFIRMED" ? 0 : 1;
  const measurementPenalty = finding.category === "measurement" ? 1 : 0;
  return verdictRank + measurementPenalty;
}
