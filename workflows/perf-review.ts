import { Type } from "typebox";
import {
  AdvisoryCandidatesSchema,
  AdvisoryReportSchema,
  AdvisoryVerdictSchema,
  type AdvisoryCandidate,
  type AdvisoryFinding,
  type AdvisoryLocation,
  type AdvisoryReport,
  type AdvisoryVerdict,
} from "../src/advisory-schema.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "perf-review",
  description: "Advisory-only performance review: scope slow path → per-lens bottleneck hypotheses → verify evidence → synthesize measurements and safe optimizations.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  target: Type.String({ description: "Verbatim slow path, workload, command, or performance concern." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files likely involved in the performance path." }),
  commands: Type.Array(Type.String(), { description: "Existing benchmark, smoke, or measurement commands relevant to this path." }),
  summary: Type.String({ description: "One-paragraph summary of the performance-relevant path." }),
  knownMeasurements: Type.Optional(Type.String({ description: "Existing measurements, timings, or explicit lack of measurements." })),
});

interface PerfLens {
  label: string;
  category: string;
  text: string;
}

type Candidate = AdvisoryCandidate;

interface Verified extends Candidate {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
  lens: PerfLens;
}

const PERF_LENSES: PerfLens[] = [
  { label: "algorithmic", category: "algorithmic", text: "Complexity, repeated scans, avoidable nested loops, or data-structure choices that grow poorly with input size." },
  { label: "io", category: "io", text: "Filesystem, subprocess, network, or other I/O costs on hot paths or startup paths." },
  { label: "concurrency", category: "concurrency", text: "Unnecessary serialization, missing batching, excessive fan-out, contention, or concurrency limits." },
  { label: "startup", category: "startup", text: "Import/module loading, initialization, discovery, or cold-start overhead." },
  { label: "allocation", category: "allocation", text: "Memory churn, large intermediate strings/objects, repeated serialization, or retained state growth." },
  { label: "measurement", category: "measurement", text: "Missing, misleading, noisy, or insufficient benchmark/measurement design." },
];

const TOOLS = ["read", "bash"];
const PER_LENS = 4;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, parallel, pipeline, phase, log, progress, args } = api;
  const target = args.trim() || "repository performance";
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
    "Establish the scope for an advisory-only performance review. Do not edit files.\n" +
      `Performance target / concern (verbatim): ${target}\n\n` +
      "Inspect repository structure, scripts, likely hot-path files, and any existing benchmark or measurement commands. " +
      "Prefer identifying what to measure before claiming bottlenecks. Return files, commands, summary, and known measurements or the lack of them. " +
      `This workflow will fan out across ${PERF_LENSES.length} lenses with up to ${PER_LENS} candidates per lens. Structured output only.`,
    { phase: "Scope", label: "scope", tools: TOOLS, thinkingLevel: "medium", schema: ScopeSchema },
  );

  if (!scope || scope.files.length === 0) {
    return emptyReport(
      "No performance-relevant files were identified.",
      ["Provide a slow command, workload, file path, or user-visible latency concern to review."],
      makeStats(0, 0),
    );
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

  const seen = new Set<string>();

  phase("Find");
  const perLens = await pipeline(
    PERF_LENSES,
    async (_prev, item) => {
      const lens = item as PerfLens;
      const found = await agent(
        `## Perf-review finder — ${lens.label}\n\n${scopeBlock}\n` +
          "This workflow is advisory-only: identify bottleneck hypotheses, measurement gaps, and safe optimization directions, but do not edit files.\n" +
          `Investigate ONLY this lens:\n${lens.text}\n\n` +
          `Surface up to ${PER_LENS} candidates. Use category exactly "${lens.category}". ` +
          "Each candidate must include a one-line summary, locations, impact stating the suspected performance consequence and workload where it matters, " +
          "and an optional recommendation. Prefer measurement recommendations when evidence is weak. Structured output only.",
        { phase: "Find", label: `find:${lens.label}`, tools: TOOLS, thinkingLevel: "low", schema: AdvisoryCandidatesSchema },
      );
      const raw = (found?.candidates ?? []).slice(0, PER_LENS);
      rawCandidateCount += raw.length;
      progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: raw.length });
      for (const candidate of raw) {
        progress({
          type: "lane_item",
          lane: "Candidates",
          title: candidate.summary,
          subtitle: formatLocation(candidate),
          status: "pending",
          details: candidate.impact,
        });
      }
      return { lens, candidates: raw };
    },
    async (prev) => {
      const { lens, candidates } = prev as { lens: PerfLens; candidates: Candidate[] };
      const novel = candidates.filter((candidate) => {
        const key = dedupKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const dropped = candidates.length - novel.length;
      if (dropped > 0) {
        droppedCandidateCount += dropped;
        progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: dropped });
        log(`find:${lens.label}: dropped ${dropped} duplicate candidate(s)`);
      }
      const verdicts = await parallel(
        novel.map((candidate) => async (): Promise<Verified | null> => {
          const location = primaryLocation(candidate);
          const judged = await agent(
            `## Perf-review verifier\n\n${scopeBlock}\n## Candidate\n` +
              `Location: ${formatLocation(candidate)}\nCategory: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}\n` +
              `Recommendation: ${candidate.recommendation ?? "(none supplied)"}\n\n` +
              "Read relevant files and package/scripts. Run only safe read-only measurement or inspection commands when useful. " +
              "Return CONFIRMED, PLAUSIBLE, or REFUTED with evidence from code, scripts, config, or measurement output. " +
              "Default toward PLAUSIBLE or REFUTED when no measurement exists; do not overstate a bottleneck. Structured output only.",
            {
              phase: "Verify",
              label: `verify:${location.file.split("/").pop() ?? location.file}`,
              tools: TOOLS,
              thinkingLevel: "low",
              schema: AdvisoryVerdictSchema,
            },
          );
          if (!judged) return null;
          progress({ type: "counter_delta", key: `verdict.${judged.verdict.toLowerCase()}`, label: judged.verdict, delta: 1 });
          if (judged.verdict === "REFUTED") {
            refutedCandidateCount += 1;
            progress({ type: "counter_delta", key: "refuted", label: "refuted", delta: 1 });
          }
          progress({
            type: "lane_item",
            lane: verdictLane(judged.verdict),
            title: candidate.summary,
            subtitle: formatLocation(candidate),
            status: verdictStatus(judged.verdict),
            details: formatEvidence(judged.evidence),
          });
          return { ...candidate, verdict: judged.verdict, evidence: judged.evidence, confidence: judged.confidence, lens };
        }),
      );
      return verdicts.filter((value): value is Verified => value !== null);
    },
  );

  const verified = (perLens as Verified[][]).flat();
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  progress({ type: "counter", key: "verified", label: "verified", value: verified.length });
  progress({ type: "counter", key: "kept", label: "kept", value: surviving.length });
  progress({ type: "summary", key: "verified", value: verified.length });
  progress({ type: "summary", key: "kept", value: surviving.length });
  log(`${verified.length} verified → ${surviving.length} kept`);

  if (surviving.length === 0) {
    return emptyReport(
      "No performance finding survived verification.",
      ["Add or run a focused measurement for the target workload before optimizing.", "Rerun perf-review with benchmark output or a narrower slow path."],
      stats,
    );
  }

  phase("Synthesize");
  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nRecommendation: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");

  const report = await agent(
    `## Synthesis: final perf-review report\n\n${ranked.length} candidates survived independent verification.\n\n${block}\n\n` +
      "Produce the shared advisory report shape. Categories should be algorithmic, io, concurrency, startup, allocation, or measurement when applicable. " +
      "Severity is expected performance impact for the target workload. Prefer measurement recommendations before optimization recommendations when evidence is weak. " +
      "Recommendations must be safe advisory next actions, not patches. Include risky optimizations to avoid in recommendations or nextSteps when relevant. Structured output only.",
    { phase: "Synthesize", label: "synthesize", thinkingLevel: "medium", schema: AdvisoryReportSchema },
  );

  if (!report) return emptyReport("Synthesis produced no output.", ["Inspect verifier evidence manually or rerun perf-review with a narrower target."], stats);

  const findings = report.findings.map((finding) => {
    const source = ranked.find((candidate) => sameFinding(candidate, finding));
    return {
      ...finding,
      evidence: finding.evidence.length > 0 ? finding.evidence : (source?.evidence ?? []),
      impact: finding.impact || source?.impact || "Performance impact not restated by synthesis.",
      recommendation: finding.recommendation || source?.recommendation || "Measure the target workload before changing code.",
    };
  });
  return { ...report, findings, stats };
}

function emptyReport(summary: string, nextSteps: string[], stats: WorkflowRunStats): AdvisoryReport & { stats: WorkflowRunStats } {
  return { summary, findings: [], nextSteps, stats };
}

function primaryLocation(candidate: Pick<Candidate, "locations">): AdvisoryLocation {
  return candidate.locations[0] ?? { file: "" };
}

function formatLocation(candidate: Pick<Candidate, "locations">): string {
  const location = primaryLocation(candidate);
  const line = location.line != null ? `:${location.line}` : "";
  const symbol = location.symbol ? ` (${location.symbol})` : "";
  return `${location.file}${line}${symbol}`;
}

function formatEvidence(evidence: string[]): string {
  return evidence.join("; ");
}

function dedupKey(candidate: Candidate): string {
  const location = primaryLocation(candidate);
  const lineKey = location.line != null ? Math.round(location.line / 5) * 5 : "file";
  return `${candidate.category}:${normalizePath(location.file)}:${lineKey}:${candidate.summary.slice(0, 60).toLowerCase()}`;
}

function normalizePath(path: string): string {
  return path.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

function rank(finding: Verified): number {
  const verdictRank = finding.verdict === "CONFIRMED" ? 0 : 1;
  const measurementPenalty = finding.category === "measurement" ? 1 : 0;
  return verdictRank + measurementPenalty;
}

function verdictLane(verdict: Verified["verdict"]): string {
  switch (verdict) {
    case "CONFIRMED":
      return "Confirmed";
    case "PLAUSIBLE":
      return "Plausible";
    case "REFUTED":
      return "Refuted";
  }
}

function verdictStatus(verdict: Verified["verdict"]): "success" | "warning" | "error" {
  switch (verdict) {
    case "CONFIRMED":
      return "success";
    case "PLAUSIBLE":
      return "warning";
    case "REFUTED":
      return "error";
  }
}

function sameFinding(candidate: Verified, finding: Pick<AdvisoryFinding, "locations" | "summary">): boolean {
  const candidateLocation = primaryLocation(candidate);
  const findingLocation = primaryLocation(finding);
  return normalizePath(candidateLocation.file) === normalizePath(findingLocation.file) && candidateLocation.line === findingLocation.line;
}
