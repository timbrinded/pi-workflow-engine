import { AdvisoryCandidatesSchema, AdvisoryVerdictSchema, type AdvisoryCandidate, type AdvisoryFinding, type AdvisoryLocation, type AdvisoryReport, type AdvisoryVerdict } from "./advisory-schema.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent } from "./types.ts";

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

const DEFAULT_ADVISORY_TOOLS = ["read", "bash"];

export interface LensVerificationPipelineOptions<Lens extends AdvisoryLens, Verified extends AdvisoryVerified> {
  api: Pick<WorkflowApi, "agent" | "parallel" | "pipeline" | "progress" | "log">;
  lenses: readonly Lens[];
  perLens: number;
  tools?: AgentOptions["tools"];
  finderPhase?: string;
  verifierPhase?: string;
  finderPrompt(lens: Lens): string;
  verifierPrompt(candidate: AdvisoryCandidate): string;
  makeVerified(candidate: AdvisoryCandidate, lens: Lens, verdict: AdvisoryVerdict): Verified;
}

export interface AdvisoryBackfillDefaults {
  impact: string;
  recommendation?: string;
}

export async function runLensVerificationPipeline<Lens extends AdvisoryLens, Verified extends AdvisoryVerified>(
  options: LensVerificationPipelineOptions<Lens, Verified>,
): Promise<LensVerificationPipelineResult<Verified>> {
  const {
    api,
    lenses,
    perLens,
    tools = DEFAULT_ADVISORY_TOOLS,
    finderPhase = "Find",
    verifierPhase = "Verify",
    finderPrompt,
    verifierPrompt,
    makeVerified,
  } = options;
  const seen = new Set<string>();
  let rawCandidates = 0;
  let dropped = 0;
  let refuted = 0;

  const perLensVerified = await api.pipeline(
    lenses,
    async (_prev, lens) => {
      const found = await api.agent(finderPrompt(lens), {
        phase: finderPhase,
        label: `find:${lens.label}`,
        tools,
        thinkingLevel: "low",
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
    },
    async ({ lens, candidates }) => {
      const novel = candidates.filter((candidate) => {
        const key = advisoryDedupKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const droppedForLens = candidates.length - novel.length;
      if (droppedForLens > 0) {
        dropped += droppedForLens;
        api.progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: droppedForLens });
        api.log(`find:${lens.label}: dropped ${droppedForLens} duplicate candidate(s)`);
      }

      const verdicts = await api.parallel(
        novel.map((candidate) => async (): Promise<Verified | null> => {
          const location = primaryLocation(candidate);
          const judged = await api.agent(verifierPrompt(candidate), {
            phase: verifierPhase,
            label: `verify:${location.file.split("/").pop() ?? location.file}`,
            tools,
            thinkingLevel: "low",
            schema: AdvisoryVerdictSchema,
          });
          if (!judged) return null;
          recordVerdictProgress(api.progress, candidate, judged, () => {
            refuted += 1;
          });
          return makeVerified(candidate, lens, judged);
        }),
      );
      return verdicts.filter((value): value is Verified => value !== null);
    },
  );

  return { verified: perLensVerified.flat(), rawCandidates, dropped, refuted };
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
  const candidateLocation = primaryLocation(candidate);
  const findingLocation = primaryLocation(finding);
  return normalizePath(candidateLocation.file) === normalizePath(findingLocation.file) && candidateLocation.line === findingLocation.line;
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
  return findings.map((finding) => {
    const source = ranked.find((candidate) => sameFinding(candidate, finding));
    return {
      ...finding,
      evidence: finding.evidence.length > 0 ? finding.evidence : (source?.evidence ?? []),
      impact: finding.impact || source?.impact || defaults.impact,
      recommendation: finding.recommendation || source?.recommendation || defaults.recommendation || "",
    };
  });
}
