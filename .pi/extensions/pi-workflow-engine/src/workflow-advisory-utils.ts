import { AdvisoryCandidatesSchema, AdvisoryVerdictSchema, type AdvisoryCandidate, type IdentifiedAdvisoryCandidate, type AdvisoryLocation, type AdvisoryReport, type AdvisoryVerdict } from "./advisory-schema.ts";
import { AdvisorySynthesisSchema, SYNTHESIS_ID_INSTRUCTIONS, withAdvisoryCoverage, collectAdvisoryStage, dedupeCandidates, identifyCandidates, uniqueLocations, type AdvisoryStageCoverage, type AdvisorySynthesis } from "./advisory-evidence.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent, WorkflowRunStats } from "./types.ts";

export interface AdvisoryLens {
  label: string;
  category: string;
  text: string;
}

export type AdvisoryVerified = IdentifiedAdvisoryCandidate & {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
  challenge?: import("./advisory-challenge.ts").ChallengeRecord;
};

export interface LensVerificationPipelineResult {
  verified: AdvisoryVerified[];
  rawCandidates: number;
  dropped: number;
  coverage: AdvisoryStageCoverage[];
}

/** Default concrete read/inspect tools for advisory workflows. */
export const DEFAULT_ADVISORY_TOOLS: NonNullable<AgentOptions["tools"]> = ["read", "bash", "grep", "find", "ls"];

/** Dynamically include installed grep/find/search-like extension tools. */
export const DEFAULT_ADVISORY_TOOL_HINTS: NonNullable<AgentOptions["toolHints"]> = ["search"];

export function emptyAdvisoryReport<Stats extends WorkflowRunStats>(
  summary: string,
  nextSteps: string[],
  stats: Stats,
): AdvisoryReport & { stats: Stats } {
  return { summary, findings: [], nextSteps, stats };
}

export function publishVerifiedKeptProgress(
  api: Pick<WorkflowApi, "progress" | "log">,
  verified: number,
  kept: number,
): void {
  api.progress({ type: "counter", key: "verified", label: "verified", value: verified });
  api.progress({ type: "counter", key: "kept", label: "kept", value: kept });
  api.progress({ type: "summary", key: "verified", value: verified });
  api.progress({ type: "summary", key: "kept", value: kept });
  api.log(`${verified} verified → ${kept} kept`);
}

export interface LensVerificationPipelineOptions {
  api: Pick<WorkflowApi, "agent" | "parallel" | "phase" | "progress" | "log">;
  lenses: readonly AdvisoryLens[];
  perLens: number;
  finderPhase?: "Find" | "Hypothesize";
  finderPrompt(lens: AdvisoryLens): string;
  verifierPrompt(candidate: IdentifiedAdvisoryCandidate): string;
  boundCandidate?(candidate: IdentifiedAdvisoryCandidate, lens: AdvisoryLens): IdentifiedAdvisoryCandidate | undefined;
}

export interface AdvisoryBackfillDefaults {
  impact: string;
  recommendation?: string;
}

/** Finish all discovery before verification competes for the shared agent limit. */
export async function runLensVerificationPipeline(
  options: LensVerificationPipelineOptions,
): Promise<LensVerificationPipelineResult> {
  const { api, lenses, perLens, finderPhase = "Find", finderPrompt, verifierPrompt, boundCandidate } = options;
  const coverage: AdvisoryStageCoverage[] = [];
  let rawCandidates = 0;
  api.phase(finderPhase);
  const found = await collectAdvisoryStage(api, "Find", lenses.map((lens) => ({ id: lens.label, run: async () => {
    const result = await api.agent(finderPrompt(lens), {
      phase: finderPhase, label: `${finderPhase.toLowerCase()}:${lens.label}`,
      tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS,
      profile: "small", schema: AdvisoryCandidatesSchema,
    });
    const raw = identifyCandidates(result.candidates.slice(0, perLens), lens.label);
    rawCandidates += raw.length;
    api.progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: raw.length });
    const candidates = boundCandidate ? raw.flatMap((candidate) => {
      const bounded = boundCandidate(candidate, lens);
      return bounded ? [bounded] : [];
    }) : raw;
    for (const candidate of candidates) {
      api.progress({ type: "lane_item", lane: finderPhase === "Hypothesize" ? "Hypotheses" : "Candidates",
        title: candidate.summary, subtitle: formatLocation(candidate), status: "pending", details: candidate.impact });
    }
    return candidates;
  } })), coverage);
  const candidates = dedupeCandidates(found.flat());
  const dropped = rawCandidates - candidates.length;
  if (dropped > 0) {
    api.progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: dropped });
    api.log(`Dropped ${dropped} duplicate or out-of-scope candidate(s)`);
  }
  api.phase("Verify");
  const verified = await collectAdvisoryStage(api, "Verify", candidates.map((candidate) => ({
    id: candidate.candidateId, candidate, run: async (): Promise<AdvisoryVerified> => {
      const location = primaryLocation(candidate);
      const judged = await api.agent(`${verifierPrompt(candidate)}\nCandidate record: ${JSON.stringify(candidate)}`, {
        phase: "Verify", label: `verify:${location.file.split("/").pop() ?? location.file}`,
        tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS,
        profile: "small", schema: AdvisoryVerdictSchema,
      });
      recordVerdictProgress(api.progress, candidate, judged);
      return { ...candidate, verdict: judged.verdict, evidence: judged.evidence, confidence: judged.confidence };
    },
  })), coverage);
  return { verified, rawCandidates, dropped, coverage };
}

export interface LensReviewConclusion {
  /** Scoped file count reported in stats. */
  files: number;
  rank(finding: AdvisoryVerified): number;
  /** Heading for each ranked finding's recommendation in the synthesis prompt. */
  recommendationLabel: string;
  /** Report used when no finding survives verification and challenge. */
  empty: { summary: string; nextSteps: string[] };
  synthesisPrompt(block: string, ranked: readonly AdvisoryVerified[], refuted: readonly AdvisoryVerified[]): string;
}

/** Rank and synthesize the findings that survived verification and challenge into the final report. */
export async function concludeLensReview(
  api: Pick<WorkflowApi, "agent" | "parallel" | "phase" | "progress" | "log">,
  pipeline: LensVerificationPipelineResult,
  verified: AdvisoryVerified[],
  conclusion: LensReviewConclusion,
) {
  const { coverage } = pipeline;
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats: WorkflowRunStats = {
    files: conclusion.files,
    candidates: pipeline.rawCandidates,
    verified: verified.length,
    kept: surviving.length,
    dropped: pipeline.dropped,
    refuted: verified.length - surviving.length,
  };
  publishVerifiedKeptProgress(api, verified.length, surviving.length);
  if (surviving.length === 0) {
    return finishAdvisoryReport(emptyAdvisoryReport(conclusion.empty.summary, conclusion.empty.nextSteps, stats), coverage, verified);
  }

  const ranked = [...surviving].sort((a, b) => conclusion.rank(a) - conclusion.rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] IDs: ${finding.sourceCandidateIds.join(", ")} ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\n${conclusion.recommendationLabel}: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");
  const refuted = verified.filter((finding) => finding.verdict === "REFUTED");
  const resolved = await synthesizeAdvisoryReport(api, conclusion.synthesisPrompt(block, ranked, refuted), ranked, coverage);
  return finishAdvisoryReport({ ...resolved, stats: { ...stats, kept: resolved.findings.length } }, coverage, verified);
}

export async function synthesizeAdvisoryReport(
  api: Pick<WorkflowApi, "agent" | "parallel" | "phase">,
  prompt: string,
  ranked: readonly AdvisoryVerified[],
  coverage: AdvisoryStageCoverage[],
): Promise<AdvisoryReport> {
  api.phase("Synthesize");
  const [report] = await collectAdvisoryStage(api, "Synthesize", [{ id: "synthesize", run: () => api.agent(
    SYNTHESIS_ID_INSTRUCTIONS + prompt,
    { phase: "Synthesize", label: "synthesize", tools: [], profile: "medium", resume: "read-only", schema: AdvisorySynthesisSchema },
  ) }], coverage);
  return resolveAdvisorySynthesis(report, ranked, {
    impact: "Impact not restated by verification.",
    recommendation: "Inspect the cited evidence and validate the smallest repair.",
  }, coverage);
}

export function finishAdvisoryReport<T extends AdvisoryReport>(
  report: T, coverage: AdvisoryStageCoverage[], verification: AdvisoryVerified[] = [],
) {
  return { ...withAdvisoryCoverage(report, coverage), verification };
}

export function primaryLocation(candidate: Pick<AdvisoryCandidate, "locations">): AdvisoryLocation {
  return candidate.locations[0] ?? { file: "" };
}

export function formatLocation(candidate: Pick<AdvisoryCandidate, "locations">): string {
  const location = primaryLocation(candidate);
  const line = location.line != null ? `:${location.line}` : "";
  const symbol = location.symbol ? ` (${location.symbol})` : "";
  return `${location.file}${line}${symbol}`;
}

export function formatEvidence(evidence: readonly string[]): string {
  return evidence.join("; ");
}

export function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

const VERDICT_PRESENTATION = {
  CONFIRMED: { lane: "Confirmed", status: "success", confidence: "high" },
  PLAUSIBLE: { lane: "Plausible", status: "warning", confidence: "medium" },
  NOT_SUBSTANTIATED: { lane: "Unresolved", status: "warning", confidence: "medium" },
  REFUTED: { lane: "Refuted", status: "error", confidence: "low" },
} satisfies Record<AdvisoryVerdict["verdict"], {
  lane: string; status: "success" | "warning" | "error"; confidence: NonNullable<AdvisoryVerdict["confidence"]>;
}>;

export function verdictConfidence(verdict: AdvisoryVerdict["verdict"]): "high" | "medium" | "low" {
  return VERDICT_PRESENTATION[verdict].confidence;
}

export function recordVerdictProgress(
  progress: (event: WorkflowProgressEvent) => void,
  candidate: Pick<AdvisoryCandidate, "locations" | "summary">,
  verdict: Pick<AdvisoryVerdict, "verdict" | "evidence">,
): void {
  progress({ type: "counter_delta", key: `verdict.${verdict.verdict.toLowerCase()}`, label: verdict.verdict, delta: 1 });
  if (verdict.verdict === "REFUTED") {
    progress({ type: "counter_delta", key: "refuted", label: "refuted", delta: 1 });
  }
  progress({
    type: "lane_item",
    lane: VERDICT_PRESENTATION[verdict.verdict].lane,
    title: candidate.summary,
    subtitle: formatLocation(candidate),
    status: VERDICT_PRESENTATION[verdict.verdict].status,
    details: formatEvidence(verdict.evidence),
  });
}

export function backfillAdvisoryFindings<Source extends AdvisoryVerified>(
  findings: AdvisorySynthesis["findings"],
  ranked: readonly Source[],
  defaults: AdvisoryBackfillDefaults,
): AdvisoryReport["findings"] {
  const sources = new Map(ranked.flatMap((source) => source.sourceCandidateIds.map((id) => [id, source] as const)));
  const used = new Set<string>();
  return findings.flatMap((selection) => {
    const ids = [...new Set(selection.sourceCandidateIds)];
    if (ids.length === 0 || ids.some((id) => !sources.has(id) || used.has(id))) return [];
    const records = [...new Set(ids.map((id) => sources.get(id)!))];
    if (records.some((record) => record.verdict === "REFUTED")) return [];
    const sourceCandidateIds = [...new Set(records.flatMap((record) => record.sourceCandidateIds))];
    if (sourceCandidateIds.some((id) => used.has(id))) return [];
    sourceCandidateIds.forEach((id) => used.add(id));
    const first = records[0]!;
    return [{
      sourceCandidateIds,
      summary: [...new Set(records.map((record) => record.summary))].join("; "),
      category: first.category,
      severity: selection.severity,
      verdict: records.some((record) => record.verdict === "NOT_SUBSTANTIATED") ? "NOT_SUBSTANTIATED" as const : records.some((record) => record.verdict === "PLAUSIBLE") ? "PLAUSIBLE" as const : "CONFIRMED" as const,
      confidence: records.every((record) => record.verdict === "CONFIRMED") ? "high" as const : "medium" as const,
      locations: uniqueLocations(records.flatMap((record) => record.locations)),
      ...(first.reviewAnchor ? { reviewAnchor: first.reviewAnchor } : {}),
      evidence: [...new Set(records.flatMap((record) => [...(record.discoveryEvidence ?? []), ...record.evidence]))],
      impact: [...new Set(records.map((record) => record.impact || defaults.impact))].join("\n"),
      recommendation: selection.recommendation || first.recommendation || defaults.recommendation || "",
    }];
  });
}

/** Retain verified records if synthesis fails, and expose invalid ID selections as a gap. */
export function resolveAdvisorySynthesis<Source extends AdvisoryVerified>(
  report: AdvisorySynthesis | undefined,
  ranked: readonly Source[],
  defaults: AdvisoryBackfillDefaults,
  coverage: AdvisoryStageCoverage[],
): AdvisoryReport {
  if (!report) {
    return {
      summary: "Synthesis unavailable; verified records retained.",
      findings: backfillAdvisoryFindings(ranked.map((finding) => ({ sourceCandidateIds: finding.sourceCandidateIds, severity: "medium", recommendation: finding.recommendation ?? defaults.recommendation ?? "Inspect verifier evidence." })), ranked, defaults),
      nextSteps: ["Inspect verifier evidence or rerun synthesis."],
    };
  }
  const findings = backfillAdvisoryFindings(report.findings, ranked, defaults);
  if (findings.length !== report.findings.length) {
    coverage.push({ stage: "Synthesis provenance", expected: report.findings.length, completed: findings.length,
      failed: report.findings.length - findings.length, failures: [{ branch: "synthesize", reason: "Discarded invalid, repeated, or unverified candidate IDs." }] });
  }
  return { ...report, findings };
}
