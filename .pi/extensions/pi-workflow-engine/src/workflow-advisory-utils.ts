import { AdvisoryCandidatesSchema, advisoryVerdictSchemas, formatAdvisoryLocation, type AdvisoryCandidate, type AdvisoryFinding, type IdentifiedAdvisoryCandidate, type AdvisoryLocation, type AdvisoryReport, type AdvisoryVerdict } from "./advisory-schema.ts";
import { AdvisorySynthesisSchema, SYNTHESIS_ID_INSTRUCTIONS, withAdvisoryCoverage, collectAdvisoryStage, dedupeCandidates, identifyCandidates, joinUniqueLines, mergeCandidateInto, repoPathCandidates, uniqueLocations, type AdvisoryStageCoverage, type AdvisorySynthesis } from "./advisory-evidence.ts";
import { isFatalWorkflowError } from "./cancellation.ts";
import { WorkflowClassifierUnavailableError } from "./classify.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent, WorkflowRunStats } from "./types.ts";


export interface AdvisoryLens {
  label: string;
  category: string;
  text: string;
}

export type AdvisoryVerified = IdentifiedAdvisoryCandidate & {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  challenge?: import("./advisory-challenge.ts").ChallengeRecord;
};

export interface LensVerificationPipelineResult {
  verified: AdvisoryVerified[];
  /** Every candidate the finders returned, including those over the per-lens cap. */
  rawCandidates: number;
  /** Candidates never verified: over the per-lens cap, duplicates, or out of scope. */
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
  api: Pick<WorkflowApi, "agent" | "agents" | "classify" | "parallel" | "phase" | "progress" | "log">;
  lenses: readonly AdvisoryLens[];
  perLens: number;
  finderPhase?: "Find" | "Hypothesize";
  finderProfile?: AgentOptions["profile"];
  finderPrompt(lens: AdvisoryLens): string;
  /** One verifier's prompt. It gets several candidates only when the agent limit leaves fewer verifiers than candidates. */
  verifierPrompt(candidates: readonly IdentifiedAdvisoryCandidate[]): string;
  /** Require the verifier to classify each finding using one of these workflow-specific categories. */
  verifierCategories?: readonly string[];
  boundCandidate?(candidate: IdentifiedAdvisoryCandidate, lens: AdvisoryLens): IdentifiedAdvisoryCandidate | undefined;
}

/** The candidate section of a verifier prompt: one record, or a batch judged in one pass. */
export function verifierCandidates(
  candidates: readonly IdentifiedAdvisoryCandidate[],
  heading: { one: string; many: string },
  fields: (candidate: IdentifiedAdvisoryCandidate) => string,
): string {
  if (candidates.length === 1) return `## ${heading.one}\n${fields(candidates[0]!)}`;
  return `## ${heading.many} (${candidates.length}: the run's agent limit leaves one verifier for several)\n` +
    candidates.map((candidate) => `### candidateId ${candidate.candidateId}\n${fields(candidate)}`).join("\n\n") +
    "\n\nJudge each on its own evidence and return one verdict per candidateId.";
}

export interface AdvisoryBackfillDefaults {
  impact: string;
  recommendation?: string;
}

/** Finish all discovery before verification competes for the shared agent limit. */
export async function runLensVerificationPipeline(
  options: LensVerificationPipelineOptions,
): Promise<LensVerificationPipelineResult> {
  const { api, lenses, perLens, finderPhase = "Find", finderProfile = "small", finderPrompt, verifierPrompt, boundCandidate } = options;
  const coverage: AdvisoryStageCoverage[] = [];
  let rawCandidates = 0;
  let overCap = 0;
  api.phase(finderPhase);
  const found = await collectAdvisoryStage(api, "Find", lenses.map((lens) => ({ id: lens.label, run: async () => {
    const result = await api.agent(finderPrompt(lens), {
      phase: finderPhase, label: `${finderPhase.toLowerCase()}:${lens.label}`,
      tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS,
      profile: finderProfile, schema: AdvisoryCandidatesSchema,
    });
    rawCandidates += result.candidates.length;
    api.progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: result.candidates.length });
    // A finder can return more than the cap its prompt states; keep the first perLens and report the rest.
    const cut = Math.max(0, result.candidates.length - perLens);
    if (cut > 0) {
      overCap += cut;
      api.progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: cut });
      api.log(`Dropped ${cut} ${lens.label} candidate(s) over the per-lens cap of ${perLens}`);
    }
    const raw = identifyCandidates(result.candidates.slice(0, perLens), lens.label);
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
  const candidates = await mergeEquivalentCandidates(api, dedupeCandidates(found.flat()));
  const duplicateOrOutOfScope = rawCandidates - overCap - candidates.length;
  if (duplicateOrOutOfScope > 0) {
    api.progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: duplicateOrOutOfScope });
    api.log(`Dropped ${duplicateOrOutOfScope} duplicate or out-of-scope candidate(s)`);
  }
  const dropped = overCap + duplicateOrOutOfScope;
  api.phase("Verify");
  // Keep one admission for the synthesis that follows. A host-set agent limit can leave fewer verifiers than
  // candidates; then each verifier judges a batch, so no candidate goes unverified and synthesis still runs.
  const batches = verificationBatches(candidates, Math.max(1, api.agents.remaining() - 1));
  if (batches.length < candidates.length) api.log(`Verifying ${candidates.length} candidates in ${batches.length} batch(es) to fit the agent limit`);
  // Each candidate keeps its own coverage branch, so a failed batch still lists every candidate it held.
  const verified = await collectAdvisoryStage(api, "Verify", batches.flatMap((batch) => {
    let judged: Promise<Array<AdvisoryVerified | Error>> | undefined;
    return batch.map((candidate, index) => ({
      id: candidate.candidateId, candidate,
      run: async () => {
        const result = (await (judged ??= verifyBatch(api, batch, verifierPrompt, options.verifierCategories)))[index]!;
        if (result instanceof Error) throw result;
        return result;
      },
    }));
  }), coverage);
  return { verified, rawCandidates, dropped, coverage };
}

/** Split candidates into at most `count` batches, keeping candidates in one file together where it fits. */
function verificationBatches(candidates: readonly IdentifiedAdvisoryCandidate[], count: number): IdentifiedAdvisoryCandidate[][] {
  if (candidates.length <= count) return candidates.map((candidate) => [candidate]);
  const byFile = [...candidates].sort((a, b) => primaryLocation(a).file.localeCompare(primaryLocation(b).file));
  const size = Math.ceil(byFile.length / count);
  return Array.from({ length: Math.ceil(byFile.length / size) }, (_, index) => byFile.slice(index * size, (index + 1) * size));
}

async function verifyBatch(
  api: Pick<WorkflowApi, "agent" | "progress">,
  batch: readonly IdentifiedAdvisoryCandidate[],
  verifierPrompt: LensVerificationPipelineOptions["verifierPrompt"],
  categories?: readonly string[],
): Promise<Array<AdvisoryVerified | Error>> {
  const location = primaryLocation(batch[0]!);
  const options = {
    phase: "Verify", label: `verify:${location.file.split("/").pop() ?? location.file}${batch.length > 1 ? ` +${batch.length - 1}` : ""}`,
    tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS,
  } as const;
  const schemas = advisoryVerdictSchemas(categories);
  const applyVerdict = (candidate: IdentifiedAdvisoryCandidate, verdict: AdvisoryVerdict & { category?: string }): AdvisoryVerified => {
    recordVerdictProgress(api.progress, candidate, verdict);
    return {
      ...candidate,
      category: categories?.length ? verdict.category ?? candidate.category : candidate.category,
      verdict: verdict.verdict,
      evidence: verdict.evidence,
    };
  };
  if (batch.length === 1) {
    const candidate = batch[0]!;
    const judged = await api.agent(`${verifierPrompt(batch)}\nCandidate record: ${JSON.stringify(candidate)}`, { ...options, profile: "small", schema: schemas.verdict });
    return [applyVerdict(candidate, judged)];
  }
  // One agent does several verifiers' work, so it gets the medium route.
  const judged = await api.agent(`${verifierPrompt(batch)}\nCandidate records: ${JSON.stringify(batch)}`,
    { ...options, profile: "medium", schema: schemas.batch(batch.map((candidate) => candidate.candidateId)) });
  const verdicts = Map.groupBy(judged.verdicts, (verdict) => verdict.candidateId);
  return batch.map((candidate) => {
    // A repeated ID passes the schema and leaves another unjudged. Neither candidate was verified,
    // so each fails its branch and the coverage reports it.
    const [verdict, ...repeated] = verdicts.get(candidate.candidateId) ?? [];
    if (!verdict) return new Error("The batch verifier returned no verdict for this candidate.");
    if (repeated.length > 0) return new Error(`The batch verifier returned ${repeated.length + 1} verdicts for this candidate.`);
    return applyVerdict(candidate, verdict);
  });
}

/** TypeSafe Jev routes in preference order. Jev is the classifier the duplicate merge was measured with. */
export const DUPLICATE_CANDIDATE_CLASSIFIERS = [
  "typesafe/jev-latest",
  "openrouter/~typesafe/jev-latest",
  "openrouter/typesafe/jev-1.13",
  "cloudflare-workers-ai/typesafe/jev",
  "vercel-ai-gateway/typesafe-ai/jev",
  "opencode/jev-1.13",
  "opencode/jev-1.13-free",
] as const;

/** Probability above which two candidates count as one defect. */
const SAME_DEFECT_PROBABILITY = 0.8;

/**
 * Merge same-file candidates that a classifier judges to be one defect, so each defect gets one verifier.
 * Lenses often report the same bug in different words; on GPT-6.1 Sol code reviews this cut verifier
 * agents and cost by about 40% without losing a finding. Runs without a reachable Jev classifier skip it.
 */
export async function mergeEquivalentCandidates<T extends IdentifiedAdvisoryCandidate>(
  api: Pick<WorkflowApi, "classify" | "parallel" | "log">,
  candidates: readonly T[],
): Promise<T[]> {
  const files = candidates.map(candidateFile);
  const pairs: Array<readonly [number, number]> = [];
  for (let first = 0; first < candidates.length; first++) {
    for (let second = first + 1; second < candidates.length; second++) {
      if (files[first] === files[second]) pairs.push([first, second]);
    }
  }
  if (pairs.length === 0) return [...candidates];
  const sameDefect = async ([first, second]: readonly [number, number]): Promise<number> => {
    const answers = await api.classify({
      state: { first: candidateForClassifier(candidates[first]!), second: candidateForClassifier(candidates[second]!) },
      questions: {
        same: {
          type: "bool",
          instructions: "Two code-review candidates were raised against the same file. Do they describe the same underlying defect (same root cause and same fix), even if worded differently?",
          criteria: { true: "Same underlying defect", false: "Different defects" },
        },
      },
    }, { model: DUPLICATE_CANDIDATE_CLASSIFIERS, label: "dedup" });
    return answers.same?.type === "bool" ? answers.same.probability : 0;
  };
  // The first call probes the classifier: if it fails for any reason (no Jev route, bad credentials, a rate
  // limit), skip the merge rather than send every other pair into the same failure.
  let firstProbability: number;
  try {
    firstProbability = await sameDefect(pairs[0]!);
  } catch (error) {
    if (isFatalWorkflowError(error, undefined)) throw error;
    if (!(error instanceof WorkflowClassifierUnavailableError)) api.log(`Skipped merging duplicate candidates: ${unknownErrorMessage(error)}`);
    return [...candidates];
  }
  if (pairs.length > 1) api.log(`Comparing ${pairs.length} same-file candidate pairs for duplicates`);
  const rest = await api.parallel(pairs.slice(1).map((pair) => () => sameDefect(pair)));
  const probability = new Map<string, number>();
  pairs.forEach(([first, second], index) => probability.set(`${first}:${second}`, index === 0 ? firstProbability : rest[index - 1] ?? 0));

  // Complete linkage: a candidate joins a group only when it matches every member, so one vague candidate
  // that resembles two different defects cannot chain them together.
  const groups: number[][] = [];
  candidates.forEach((_, index) => {
    const group = groups.find((members) =>
      members.every((member) => (probability.get(`${member}:${index}`) ?? 0) >= SAME_DEFECT_PROBABILITY));
    if (group) group.push(index);
    else groups.push([index]);
  });
  const merged = groups.map(([keep, ...folded]) => {
    const kept = { ...candidates[keep!]! };
    for (const index of folded) {
      const duplicate = candidates[index]!;
      mergeCandidateInto(kept, duplicate);
      // The kept summary leads; keep folded wording visible to the verifier in case the classifier was wrong.
      if (duplicate.summary !== kept.summary) {
        kept.discoveryEvidence = [...new Set([...(kept.discoveryEvidence ?? []), `Also reported as: ${duplicate.summary}`])];
      }
    }
    return kept;
  });
  const folded = candidates.length - merged.length;
  if (folded > 0) api.log(`Merged ${folded} candidate(s) describing the same defect before verification`);
  return merged;
}

/** Pair by the changed line when there is one, with the repository-relative path exact dedup uses. */
function candidateFile(candidate: IdentifiedAdvisoryCandidate): string {
  return repoPathCandidates((candidate.reviewAnchor ?? primaryLocation(candidate)).file)[1];
}

function candidateForClassifier(candidate: IdentifiedAdvisoryCandidate) {
  return {
    category: candidate.category,
    summary: candidate.summary,
    impact: candidate.impact,
    location: formatLocation(candidate),
    evidence: (candidate.discoveryEvidence ?? []).slice(0, 4),
  };
}

/** Stats for a lens review that stopped before discovery. */
export const EMPTY_LENS_REVIEW_STATS: Readonly<WorkflowRunStats> = Object.freeze({ files: 0, candidates: 0, verified: 0, kept: 0, dropped: 0, refuted: 0 });

export interface LensReviewConclusion {
  /** Scoped file count reported in stats. */
  files: number;
  rank(finding: AdvisoryVerified): number;
  /** One ranked finding's synthesis-prompt block, headed by the IDs synthesis selects; defaults to {@link formatRankedFinding}. */
  formatFinding?(finding: AdvisoryVerified, index: number): string;
  /** Report used when no finding survives verification and challenge. */
  empty: { summary: string; nextSteps: string[] };
  synthesisPrompt(block: string, ranked: readonly AdvisoryVerified[], refuted: readonly AdvisoryVerified[]): string;
}

export function formatRankedFinding(finding: AdvisoryVerified, index: number, recommendationLabel = "Recommendation"): string {
  return `### [${index}] IDs: ${finding.sourceCandidateIds.join(", ")} ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
    `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\n${recommendationLabel}: ${finding.recommendation ?? "(none supplied)"}`;
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
  const block = ranked.map((finding, index) => (conclusion.formatFinding ?? formatRankedFinding)(finding, index)).join("\n\n");
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
    { phase: "Synthesize", label: "synthesize", tools: [], skills: [], profile: "medium", resume: "read-only", schema: AdvisorySynthesisSchema },
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
  return formatAdvisoryLocation(primaryLocation(candidate));
}

export function formatEvidence(evidence: readonly string[]): string {
  return evidence.join("; ");
}

const VERDICT_PRESENTATION = {
  CONFIRMED: { lane: "Confirmed", status: "success", confidence: "high" },
  PLAUSIBLE: { lane: "Plausible", status: "warning", confidence: "medium" },
  NOT_SUBSTANTIATED: { lane: "Unresolved", status: "warning", confidence: "medium" },
  REFUTED: { lane: "Refuted", status: "error", confidence: "low" },
} satisfies Record<AdvisoryVerdict["verdict"], {
  lane: string; status: "success" | "warning" | "error"; confidence: AdvisoryFinding["confidence"];
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
      impact: joinUniqueLines(records.map((record) => record.impact || defaults.impact)),
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
