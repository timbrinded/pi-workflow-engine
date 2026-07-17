import {
  MAX_RESEARCH_LANES,
  MAX_VERIFICATION_CLAIMS,
  type ResearchClaimCandidate,
  type ResearchEvidence,
  type ResearchLane,
  type ResearchLaneResult,
  type ResearchPlan,
  type ResearchReport,
  type ResearchReportEntry,
  type ResearchSource,
  type ResearchVerification,
} from "./research-contract.ts";

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "ref_src"]);
const IMPORTANCE_RANK: Readonly<Record<ResearchEvidence["importance"], number>> = { high: 0, medium: 1, low: 2 };

export function normalizeResearchLanes(plan: ResearchPlan): ResearchLane[] {
  const seen = new Set<string>();
  const lanes: ResearchLane[] = [];
  for (const lane of plan.lanes) {
    const id = normalizedText(lane.id);
    const title = normalizedText(lane.title);
    const objective = normalizedText(lane.objective);
    const queries = dedupeText(lane.queries).slice(0, 4);
    if (!id || !title || !objective || queries.length === 0 || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    lanes.push({ id, title, objective, queries });
    if (lanes.length >= MAX_RESEARCH_LANES) break;
  }
  return lanes;
}

export function sanitizeLaneResults(results: readonly ResearchLaneResult[]): ResearchLaneResult[] {
  return results.map((result) => ({
    laneId: normalizedText(result.laneId),
    gaps: dedupeText(result.gaps),
    evidence: dedupeEvidence(result.evidence.map(sanitizeEvidence).filter(isDefined)),
  }));
}

export function buildClaimCandidates(results: readonly ResearchLaneResult[]): ResearchClaimCandidate[] {
  const byClaim = new Map<string, { claim: string; importance: ResearchEvidence["importance"]; evidence: ResearchEvidence[] }>();
  for (const item of results.flatMap((result) => result.evidence)) {
    const key = normalizedText(item.claim).toLowerCase();
    if (!key) continue;
    const current = byClaim.get(key);
    if (!current) {
      byClaim.set(key, { claim: normalizedText(item.claim), importance: item.importance, evidence: [item] });
      continue;
    }
    if (IMPORTANCE_RANK[item.importance] < IMPORTANCE_RANK[current.importance]) current.importance = item.importance;
    current.evidence = dedupeEvidence([...current.evidence, item]);
  }
  return [...byClaim.values()]
    .sort((left, right) => IMPORTANCE_RANK[left.importance] - IMPORTANCE_RANK[right.importance])
    .slice(0, MAX_VERIFICATION_CLAIMS);
}

export function sanitizeVerification(
  verification: ResearchVerification,
  candidate: ResearchClaimCandidate,
): ResearchVerification {
  const sources = dedupeSources(verification.sources);
  const verdict = (verification.verdict === "SUPPORTED" || verification.verdict === "CONFLICTED") && sources.length === 0
    ? "UNCERTAIN"
    : verification.verdict;
  return {
    claim: candidate.claim,
    verdict,
    explanation: normalizedText(verification.explanation) || "Independent verification returned no explanation.",
    sources,
  };
}

export function unavailableVerification(candidate: ResearchClaimCandidate): ResearchVerification {
  return {
    claim: candidate.claim,
    verdict: "UNCERTAIN",
    explanation: "Independent verification did not complete; gathered evidence remains unverified.",
    sources: dedupeSources(candidate.evidence.map((item) => item.source)),
  };
}

export function sanitizeResearchReport(
  report: ResearchReport,
  verifications: readonly ResearchVerification[],
): ResearchReport {
  const sources = dedupeSources(
    verifications
      .filter((verification) => verification.verdict !== "REJECTED")
      .flatMap((verification) => verification.sources),
  );
  const uncertainties = sanitizeEntries(
    report.uncertainties,
    verificationSources(verifications, "UNCERTAIN"),
    false,
  );
  const supportedClaims = sanitizeEntries(
    report.supportedClaims,
    verificationSources(verifications, "SUPPORTED"),
    true,
    uncertainties,
  );
  const conflictingEvidence = sanitizeEntries(
    report.conflictingEvidence,
    verificationSources(verifications, "CONFLICTED"),
    true,
    uncertainties,
  );
  const inferences = sanitizeEntries(
    report.inferences,
    verificationSources(verifications, "INFERENCE"),
    false,
  );
  return {
    answer: normalizedText(report.answer),
    supportedClaims,
    conflictingEvidence,
    uncertainties,
    inferences,
    sources,
    limitations: dedupeText(report.limitations),
    nextSteps: dedupeText(report.nextSteps),
  };
}

function verificationSources(
  verifications: readonly ResearchVerification[],
  verdict: ResearchVerification["verdict"],
): ReadonlyMap<string, ReadonlyMap<string, ResearchSource>> {
  const byClaim = new Map<string, Map<string, ResearchSource>>();
  for (const verification of verifications) {
    if (verification.verdict !== verdict) continue;
    const key = normalizedText(verification.claim).toLowerCase();
    const claimSources = byClaim.get(key) ?? new Map<string, ResearchSource>();
    dedupeSources(
      verification.sources,
    ).forEach((source) => claimSources.set(source.url, source));
    byClaim.set(key, claimSources);
  }
  return byClaim;
}

export function fallbackResearchReport(
  verifications: readonly ResearchVerification[],
  limitation: string,
): ResearchReport {
  const entry = (verification: ResearchVerification): ResearchReportEntry => ({
    claim: verification.claim,
    explanation: verification.explanation,
    citations: verification.sources,
  });
  return {
    answer: "The synthesis stage did not complete; independently verified claims are grouped below without additional model interpretation.",
    supportedClaims: verifications.filter((item) => item.verdict === "SUPPORTED").map(entry),
    conflictingEvidence: verifications.filter((item) => item.verdict === "CONFLICTED").map(entry),
    uncertainties: verifications.filter((item) => item.verdict === "UNCERTAIN").map(entry),
    inferences: verifications.filter((item) => item.verdict === "INFERENCE").map(entry),
    sources: dedupeSources(verifications.flatMap((verification) => verification.sources)),
    limitations: [limitation],
    nextSteps: ["Review the verified claim groups and rerun synthesis if a narrative answer is required."],
  };
}

export function unavailableResearchReport(reason: "empty-question" | "missing-capability" | "no-evidence"): ResearchReport {
  const message = reason === "empty-question"
    ? "No research question was provided."
    : reason === "missing-capability"
      ? "Research could not start because pi exposed no installed external web-search or URL-extraction tool."
      : "Research completed without enough direct-page evidence to support an answer.";
  const nextStep = reason === "empty-question"
    ? "Run `/workflow research <question>` and include any source, date, or geography constraints in the arguments."
    : reason === "missing-capability"
      ? "Install or enable a pi tool that can search the web or extract HTTP(S) pages, then rerun the workflow."
      : "Check the installed external-search tool, narrow the question, or provide preferred source domains.";
  return {
    answer: message,
    supportedClaims: [],
    conflictingEvidence: [],
    uncertainties: [],
    inferences: [],
    sources: [],
    limitations: [message],
    nextSteps: [nextStep],
  };
}

export function canonicalSourceUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
    if (isSearchResultsUrl(url)) return undefined;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
    return url.toString();
  } catch {
    return undefined;
  }
}

export function dedupeSources(sources: readonly ResearchSource[]): ResearchSource[] {
  const byUrl = new Map<string, ResearchSource>();
  for (const source of sources) {
    const url = canonicalSourceUrl(source.url);
    const title = normalizedText(source.title);
    if (!url || !title || byUrl.has(url)) continue;
    const publishedAt = source.publishedAt === undefined ? undefined : normalizedText(source.publishedAt);
    byUrl.set(url, { title, url, ...(publishedAt ? { publishedAt } : {}) });
  }
  return [...byUrl.values()];
}

function sanitizeEvidence(item: ResearchEvidence): ResearchEvidence | undefined {
  const source = dedupeSources([item.source])[0];
  const claim = normalizedText(item.claim);
  const evidence = normalizedText(item.evidence);
  if (!source || !claim || !evidence) return undefined;
  return { claim, importance: item.importance, stance: item.stance, evidence, source };
}

function dedupeEvidence(evidence: readonly ResearchEvidence[]): ResearchEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.claim.toLowerCase()}\0${item.stance}\0${item.source.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeEntries(
  entries: readonly ResearchReportEntry[],
  allowedByClaim: ReadonlyMap<string, ReadonlyMap<string, ResearchSource>>,
  requireCitation: boolean,
  demoted: ResearchReportEntry[] = [],
): ResearchReportEntry[] {
  const sanitized: ResearchReportEntry[] = [];
  for (const entry of entries) {
    const claim = normalizedText(entry.claim);
    const explanation = normalizedText(entry.explanation);
    if (!claim || !explanation) continue;
    const allowed = allowedByClaim.get(claim.toLowerCase()) ?? new Map<string, ResearchSource>();
    const citations = dedupeSources(entry.citations)
      .map((source) => allowed.get(source.url))
      .filter(isDefined);
    if (requireCitation && citations.length === 0) {
      demoted.push({ claim, explanation: `${explanation} No verified direct-page citation survived validation.`, citations: [] });
      continue;
    }
    sanitized.push({ claim, explanation, citations });
  }
  return sanitized;
}

function isSearchResultsUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (/^(?:google\.[a-z.]+|bing\.com|search\.yahoo\.com|search\.brave\.com|yandex\.[a-z.]+)$/.test(host)) {
    return path === "/search" || path === "/results" || path === "/yandsearch";
  }
  if (host === "duckduckgo.com") return (path === "/" || path === "/html" || path === "/lite") && url.searchParams.has("q");
  return false;
}

function dedupeText(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizedText(value);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizedText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
