import { AdvisoryCandidatesSchema, AdvisoryVerdictSchema, type AdvisoryCandidate, type AdvisoryFinding, type AdvisoryLocation, type AdvisoryReport, type AdvisoryVerdict } from "./advisory-schema.ts";
import { candidateDedupKey, candidateIds, collectAdvisoryStage, dedupeCandidates, identifyCandidates, uniqueLocations, type AdvisoryStageCoverage, type AdvisorySynthesis } from "./advisory-evidence.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent, WorkflowRunStats } from "./types.ts";

export interface AdvisoryLens {
  label: string;
  category: string;
  text: string;
}

export type AdvisoryVerified<Candidate extends AdvisoryCandidate = AdvisoryCandidate> = Candidate & {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
  challenge?: import("./advisory-challenge.ts").ChallengeRecord;
};

export interface LensVerificationPipelineResult<Verified> {
  verified: Verified[];
  rawCandidates: number;
  dropped: number;
  refuted: number;
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

export type AdvisorySchedulingMode = "pipeline" | "finder-barrier";

export interface LensVerificationPipelineOptions<Lens extends AdvisoryLens, Verified extends AdvisoryVerified> {
  api: Pick<WorkflowApi, "agent" | "parallel" | "pipeline" | "progress" | "log">;
  lenses: readonly Lens[];
  perLens: number;
  tools?: AgentOptions["tools"];
  toolHints?: AgentOptions["toolHints"];
  finderPhase?: string;
  verifierPhase?: string;
  schedulingMode?: AdvisorySchedulingMode;
  finderPrompt(lens: Lens): string;
  verifierPrompt(candidate: AdvisoryCandidate): string;
  makeVerified(candidate: AdvisoryCandidate, lens: Lens, verdict: AdvisoryVerdict): Verified;
}

export interface AdvisoryBackfillDefaults {
  impact: string;
  recommendation?: string;
}

interface FoundForLens<Lens> {
  lens: Lens;
  candidates: AdvisoryCandidate[];
}

interface NovelCandidate<Lens> {
  lens: Lens;
  candidate: AdvisoryCandidate;
}

export async function runLensVerificationPipeline<Lens extends AdvisoryLens, Verified extends AdvisoryVerified>(
  options: LensVerificationPipelineOptions<Lens, Verified>,
): Promise<LensVerificationPipelineResult<Verified>> {
  const {
    api,
    lenses,
    perLens,
    tools = DEFAULT_ADVISORY_TOOLS,
    toolHints = DEFAULT_ADVISORY_TOOL_HINTS,
    finderPhase = "Find",
    verifierPhase = "Verify",
    schedulingMode = "pipeline",
    finderPrompt,
    verifierPrompt,
    makeVerified,
  } = options;
  const coverage: AdvisoryStageCoverage[] = [];
  let rawCandidates = 0;
  let dropped = 0;
  let refuted = 0;

  const findForLens = async (lens: Lens): Promise<FoundForLens<Lens>> => {
    const found = await api.agent(finderPrompt(lens), {
      phase: finderPhase,
      label: `find:${lens.label}`,
      tools,
      toolHints,
      profile: "small",
      schema: AdvisoryCandidatesSchema,
    });
    if (!found) throw new Error("Finder produced no output");
    const candidates = identifyCandidates(found.candidates.slice(0, perLens), lens.label);
    rawCandidates += candidates.length;
    api.progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: candidates.length });
    for (const candidate of candidates) {
      api.progress({
        type: "lane_item",
        lane: "Candidates",
        title: candidate.summary,
        subtitle: formatLocation(candidate),
        status: "pending",
        details: candidate.impact,
      });
    }
    return { lens, candidates };
  };

  const verifyCandidate = async ({ lens, candidate }: NovelCandidate<Lens>): Promise<Verified> => {
    const location = primaryLocation(candidate);
    const judged = await api.agent(`${verifierPrompt(candidate)}\nCandidate record: ${JSON.stringify(candidate)}`, {
      phase: verifierPhase,
      label: `verify:${location.file.split("/").pop() ?? location.file}`,
      tools,
      toolHints,
      profile: "small",
      schema: AdvisoryVerdictSchema,
    });
    if (!judged) throw new Error("Verifier produced no output");
    recordVerdictProgress(api.progress, candidate, judged, () => {
      refuted += 1;
    });
    return makeVerified(candidate, lens, judged);
  };

  const verify = async (found: FoundForLens<Lens>[]): Promise<Verified[]> => {
    const entries = dedupeCandidates(found.flatMap(({ lens, candidates }) => candidates.map((candidate) => ({ ...candidate, lens }))));
    dropped += found.reduce((count, group) => count + group.candidates.length, 0) - entries.length;
    const results = await collectAdvisoryStage(api, "Verify", entries.map(({ lens, ...candidate }) => ({
      id: candidate.candidateId!, candidate, run: async () => verifyCandidate({ lens, candidate }),
    })), coverage);
    return results;
  };
  let verified: Verified[];
  if (schedulingMode === "finder-barrier") {
    const found = await collectAdvisoryStage(api, "Find", lenses.map((lens) => ({ id: lens.label, run: () => findForLens(lens) })), coverage);
    verified = await verify(found);
  } else {
    // Each lens can start verification immediately; cross-lens merging waits for synthesis.
    const results = await collectAdvisoryStage(api, "Lenses", lenses.map((lens) => ({ id: lens.label, run: async () => {
      const found = await collectAdvisoryStage(api, "Find", [{ id: lens.label, run: () => findForLens(lens) }], coverage);
      return verify(found);
    } })), coverage);
    verified = results.flat();
  }
  return { verified, rawCandidates, dropped, refuted, coverage };
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

export function advisoryDedupKey(candidate: AdvisoryCandidate): string {
  return candidateDedupKey(candidate);
}

export function verdictLane(verdict: AdvisoryVerdict["verdict"]): string {
  switch (verdict) {
    case "CONFIRMED":
      return "Confirmed";
    case "NOT_SUBSTANTIATED":
      return "Unresolved";
    case "PLAUSIBLE":
      return "Plausible";
    case "REFUTED":
      return "Refuted";
  }
}

export function verdictStatus(verdict: AdvisoryVerdict["verdict"]): "success" | "warning" | "error" {
  switch (verdict) {
    case "CONFIRMED":
      return "success";
    case "NOT_SUBSTANTIATED":
    case "PLAUSIBLE":
      return "warning";
    case "REFUTED":
      return "error";
  }
}

export function verdictConfidence(verdict: AdvisoryVerdict["verdict"]): "high" | "medium" | "low" {
  switch (verdict) {
    case "CONFIRMED":
      return "high";
    case "NOT_SUBSTANTIATED":
    case "PLAUSIBLE":
      return "medium";
    case "REFUTED":
      return "low";
  }
}

export function sameFinding(candidate: Pick<AdvisoryCandidate, "locations">, finding: Pick<AdvisoryFinding, "locations" | "summary">): boolean {
  return findingLocationKey(candidate) === findingLocationKey(finding);
}

export function findingLocationKey(value: Pick<AdvisoryCandidate, "locations"> | Pick<AdvisoryFinding, "locations">): string {
  const location = primaryLocation(value);
  return `${normalizePath(location.file)}:${location.line ?? "file"}`;
}

export function recordVerdictProgress(
  progress: (event: WorkflowProgressEvent) => void,
  candidate: Pick<AdvisoryCandidate, "locations" | "summary">,
  verdict: Pick<AdvisoryVerdict, "verdict" | "evidence">,
  onRefuted?: () => void,
): void {
  progress({ type: "counter_delta", key: `verdict.${verdict.verdict.toLowerCase()}`, label: verdict.verdict, delta: 1 });
  if (verdict.verdict === "REFUTED") {
    onRefuted?.();
    progress({ type: "counter_delta", key: "refuted", label: "refuted", delta: 1 });
  }
  progress({
    type: "lane_item",
    lane: verdictLane(verdict.verdict),
    title: candidate.summary,
    subtitle: formatLocation(candidate),
    status: verdictStatus(verdict.verdict),
    details: formatEvidence(verdict.evidence),
  });
}

export function backfillAdvisoryFindings<Source extends AdvisoryVerified>(
  findings: AdvisorySynthesis["findings"],
  ranked: readonly Source[],
  defaults: AdvisoryBackfillDefaults,
): AdvisoryReport["findings"] {
  const sources = new Map(ranked.flatMap((source) => candidateIds(source).map((id) => [id, source] as const)));
  const used = new Set<string>();
  return findings.flatMap((selection) => {
    const ids = [...new Set(selection.sourceCandidateIds)];
    if (ids.length === 0 || ids.some((id) => !sources.has(id) || used.has(id))) return [];
    const records = [...new Set(ids.map((id) => sources.get(id)!))];
    if (records.some((record) => record.verdict === "REFUTED")) return [];
    const sourceCandidateIds = [...new Set(records.flatMap(candidateIds))];
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
      findings: backfillAdvisoryFindings(ranked.map((finding) => ({ sourceCandidateIds: candidateIds(finding), severity: "medium", recommendation: finding.recommendation ?? defaults.recommendation ?? "Inspect verifier evidence." })), ranked, defaults),
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
