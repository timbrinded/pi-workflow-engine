import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { AdvisorySeveritySchema, type IdentifiedAdvisoryCandidate, type AdvisoryCandidate, type AdvisoryReport } from "./advisory-schema.ts";
import type { WorkflowApi } from "./types.ts";

export interface AdvisoryStageCoverage {
  stage: string;
  expected: number;
  completed: number;
  failed: number;
  failures: { branch: string; reason: string; candidate?: AdvisoryCandidate }[];
}

/** Settled results are required here: a missing branch is not a negative finding. */
export async function collectAdvisoryStage<T>(
  api: Pick<WorkflowApi, "parallel">,
  stage: string,
  branches: { id: string; candidate?: AdvisoryCandidate; run(): Promise<T> }[],
  coverage: AdvisoryStageCoverage[],
): Promise<T[]> {
  const results = await api.parallel(branches.map((branch) => branch.run), { settled: true });
  const failures = results.flatMap((result, index) => result.ok ? [] : [{ branch: branches[index]!.id, reason: result.error.message, ...(branches[index]!.candidate ? { candidate: branches[index]!.candidate } : {}) }]);
  coverage.push({ stage, expected: branches.length, completed: results.length - failures.length, failed: failures.length, failures });
  return results.flatMap((result) => result.ok ? [result.value] : []);
}

export function identifyCandidates(candidates: readonly AdvisoryCandidate[], lens: string): IdentifiedAdvisoryCandidate[] {
  return candidates.map((candidate, index) => {
    const candidateId = createHash("sha256").update(JSON.stringify([lens, index, candidate])).digest("hex").slice(0, 20);
    // Identities are assigned by the workflow, never accepted from a finder.
    return { ...candidate, candidateId, sourceCandidateIds: [candidateId] };
  });
}

function normalizedSummary(summary: string): string {
  return summary.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
}

function candidateDedupKey(candidate: AdvisoryCandidate): string {
  const location = candidate.locations[0];
  return JSON.stringify([candidate.category, location?.file.replace(/^\.\//, "").replace(/^[ab]\//, ""),
    location?.symbol ?? location?.line ?? null, normalizedSummary(candidate.summary)]);
}

/** Collapse only equivalent claims at the same anchor; keep every discovery ID and location. */
export function dedupeCandidates<T extends IdentifiedAdvisoryCandidate>(candidates: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const candidate of candidates) {
    const key = candidateDedupKey(candidate);
    const previous = seen.get(key);
    if (!previous) seen.set(key, { ...candidate });
    else {
      previous.sourceCandidateIds = [...new Set([...previous.sourceCandidateIds, ...candidate.sourceCandidateIds])];
      previous.locations = uniqueLocations([...previous.locations, ...candidate.locations]);
      previous.impact = [...new Set([previous.impact, candidate.impact])].join("\n");
      previous.discoveryEvidence = [...new Set([...(previous.discoveryEvidence ?? []), ...(candidate.discoveryEvidence ?? [])])];
    }
  }
  return [...seen.values()];
}

export function uniqueLocations(locations: AdvisoryCandidate["locations"]): AdvisoryCandidate["locations"] {
  return [...new Map(locations.map((location) => [JSON.stringify(location), location])).values()];
}

// Synthesis selects evidence records. It has no fields with which to replace their evidence.
export const AdvisorySynthesisSchema = Type.Object({
  summary: Type.String(),
  findings: Type.Array(Type.Object({
    sourceCandidateIds: Type.Array(Type.String(), { minItems: 1 }),
    severity: AdvisorySeveritySchema,
    recommendation: Type.String(),
  })),
  nextSteps: Type.Array(Type.String()),
});
export type AdvisorySynthesis = Static<typeof AdvisorySynthesisSchema>;
export const SYNTHESIS_ID_INSTRUCTIONS = "Select or merge findings only by sourceCandidateIds shown below. Return severity and an advisory recommendation per selection. Never select an ID absent from these verified records. ";

export function withAdvisoryCoverage<T extends AdvisoryReport>(report: T, coverage: AdvisoryStageCoverage[]) {
  const incomplete = coverage.some((stage) => stage.failed > 0);
  const gaps = coverage.flatMap((stage) => stage.failures.map((failure) => `${stage.stage}/${failure.branch}: ${failure.reason}`));
  return {
    ...report,
    status: incomplete ? "incomplete" as const : "complete" as const,
    summary: incomplete ? `Incomplete review: ${gaps.length} branch(es) failed. ${report.findings.length} finding(s) available; no clean conclusion is possible.` : report.summary,
    nextSteps: incomplete ? ["Inspect failed branches and rerun missing work.", ...(report.findings.length > 0 ? report.nextSteps : [])] : report.nextSteps,
    coverage,
    gaps,
  };
}
