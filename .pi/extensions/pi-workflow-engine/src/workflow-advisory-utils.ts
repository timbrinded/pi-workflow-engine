import { AdvisoryCandidatesSchema, AdvisoryVerdictSchema, type AdvisoryCandidate, type AdvisoryFinding, type AdvisoryLocation, type AdvisoryReport, type AdvisoryVerdict } from "./advisory-schema.ts";
import { compactResults } from "./concurrency.ts";
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
};

export interface LensVerificationPipelineResult<Verified> {
  verified: Verified[];
  rawCandidates: number;
  dropped: number;
  refuted: number;
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
  const seen = new Set<string>();
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
    const candidates = (found?.candidates ?? []).slice(0, perLens);
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

  const dedupeFound = (found: FoundForLens<Lens>): NovelCandidate<Lens>[] => {
    const novel = candidatesNovelToRun(found.candidates, seen).map((candidate) => ({ lens: found.lens, candidate }));
    const droppedForLens = found.candidates.length - novel.length;
    if (droppedForLens > 0) {
      dropped += droppedForLens;
      api.progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: droppedForLens });
      api.log(`find:${found.lens.label}: dropped ${droppedForLens} duplicate candidate(s)`);
    }
    return novel;
  };

  const verifyCandidate = async ({ lens, candidate }: NovelCandidate<Lens>): Promise<Verified | null> => {
    const location = primaryLocation(candidate);
    const judged = await api.agent(verifierPrompt(candidate), {
      phase: verifierPhase,
      label: `verify:${location.file.split("/").pop() ?? location.file}`,
      tools,
      toolHints,
      profile: "small",
      schema: AdvisoryVerdictSchema,
    });
    if (!judged) return null;
    recordVerdictProgress(api.progress, candidate, judged, () => {
      refuted += 1;
    });
    return makeVerified(candidate, lens, judged);
  };

  if (schedulingMode === "finder-barrier") {
    const found = await api.parallel(lenses.map((lens) => async () => findForLens(lens)));
    const novel = compactResults(found).flatMap(dedupeFound);
    const verdicts = await api.parallel(novel.map((entry) => async () => verifyCandidate(entry)));
    return { verified: compactResults(verdicts), rawCandidates, dropped, refuted };
  }

  const perLensVerified = await api.pipeline(
    lenses,
    async (_prev, lens) => findForLens(lens),
    async (found) => {
      const novel = dedupeFound(found);
      const verdicts = await api.parallel(novel.map((entry) => async () => verifyCandidate(entry)));
      return compactResults(verdicts);
    },
  );

  return { verified: compactResults(perLensVerified).flat(), rawCandidates, dropped, refuted };
}

function candidatesNovelToRun(candidates: readonly AdvisoryCandidate[], seen: Set<string>): AdvisoryCandidate[] {
  return candidates.filter((candidate) => {
    const key = advisoryDedupKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const location = primaryLocation(candidate);
  const lineKey = location.line != null ? Math.round(location.line / 5) * 5 : "file";
  return `${candidate.category}:${normalizePath(location.file)}:${lineKey}:${candidate.summary.slice(0, 60).toLowerCase()}`;
}

export function verdictLane(verdict: AdvisoryVerdict["verdict"]): string {
  switch (verdict) {
    case "CONFIRMED":
      return "Confirmed";
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
  findings: AdvisoryReport["findings"],
  ranked: readonly Source[],
  defaults: AdvisoryBackfillDefaults,
): AdvisoryReport["findings"] {
  const rankedByLocation = new Map<string, Source>();
  for (const candidate of ranked) {
    const key = findingLocationKey(candidate);
    if (!rankedByLocation.has(key)) rankedByLocation.set(key, candidate);
  }

  return findings.map((finding) => {
    const source = rankedByLocation.get(findingLocationKey(finding));
    return {
      ...finding,
      evidence: finding.evidence.length > 0 ? finding.evidence : (source?.evidence ?? []),
      impact: finding.impact || source?.impact || defaults.impact,
      recommendation: finding.recommendation || source?.recommendation || defaults.recommendation || "",
    };
  });
}
