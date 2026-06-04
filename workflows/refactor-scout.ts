import { Type } from "typebox";
import {
  AdvisoryReportSchema,
  type AdvisoryCandidate,
  type AdvisoryReport,
  type AdvisoryVerdict,
} from "../src/advisory-schema.ts";
import {
  backfillAdvisoryFindings,
  formatEvidence,
  formatLocation,
  runLensVerificationPipeline,
} from "../src/workflow-advisory-utils.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "refactor-scout",
  description: "Advisory-only refactor scout: scope → per-lens find → independent verify → synthesize safe refactor opportunities.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  target: Type.String({ description: "Verbatim target path, module, or focus area being scouted." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files in scope." }),
  summary: Type.String({ description: "One-paragraph summary of the scoped code." }),
  conventions: Type.Optional(Type.String({ description: "Relevant project conventions from AGENTS.md / CLAUDE.md / docs." })),
});

interface RefactorLens {
  label: string;
  category: string;
  text: string;
}

type Candidate = AdvisoryCandidate;

interface Verified extends Candidate {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
  lens: RefactorLens;
}

const REFACTOR_LENSES: RefactorLens[] = [
  { label: "duplication", category: "duplication", text: "Repeated logic, copy-pasted structures, or near-duplicate flows that could share one clearer implementation." },
  { label: "complexity", category: "complexity", text: "Oversized functions, tangled control flow, or abstractions that make local reasoning harder than necessary." },
  { label: "type-safety", category: "type-safety", text: "Weak typing, avoidable casts, unchecked shapes, or places stronger types would prevent mistakes." },
  { label: "boundaries", category: "boundary", text: "Leaky module boundaries, misplaced responsibilities, or imports that couple unrelated layers." },
  { label: "dead-code", category: "dead-code", text: "Unused, obsolete, or redundant code paths that can likely be removed safely." },
  { label: "conventions", category: "conventions", text: "Departures from project conventions, naming, dependency rules, or local idioms." },
];

const TOOLS = ["read", "bash"];
const PER_LENS = 5;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, parallel, pipeline, phase, log, progress, args } = api;
  const target = args.trim() || ".";
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
    "Establish the scope for an advisory-only refactor scout. Do not edit files.\n" +
      `Target / focus (verbatim): ${target}\n\n` +
      "Inspect repository structure, the target path or module, and relevant AGENTS.md / CLAUDE.md conventions. " +
      "Return the concrete files that should be considered, a short summary, and any conventions that affect refactor advice. " +
      `This workflow will fan out across ${REFACTOR_LENSES.length} lenses with up to ${PER_LENS} candidates per lens. Structured output only.`,
    { phase: "Scope", label: "scope", tools: TOOLS, thinkingLevel: "medium", schema: ScopeSchema },
  );

  if (!scope || scope.files.length === 0) {
    return emptyReport(
      "No files were identified for refactor scouting.",
      ["Provide a target path, module, or subsystem to scout for refactor opportunities."],
      makeStats(0, 0),
    );
  }

  fileCount = scope.files.length;
  progress({ type: "counter", key: "files", label: "files", value: fileCount });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") });
  log(`${scope.files.length} files scoped for refactor scouting`);

  const scopeBlock =
    `## Target\n${scope.target}\n\n## Files in scope\n${scope.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Summary\n${scope.summary}\n\n## Conventions\n${scope.conventions ?? "(none noted)"}\n` +
    (args.trim() ? `\n## User instructions (verbatim)\n${args.trim()}\n` : "");

  phase("Find");
  const pipelineResult = await runLensVerificationPipeline({
    api: { agent, parallel, pipeline, progress, log },
    lenses: REFACTOR_LENSES,
    perLens: PER_LENS,
    tools: TOOLS,
    finderPrompt: (lens) =>
      `## Refactor-scout finder — ${lens.label}\n\n${scopeBlock}\n` +
      "This workflow is advisory-only: do not edit files and do not propose broad rewrites.\n" +
      `Scout through ONLY this lens:\n${lens.text}\n\n` +
      `Surface up to ${PER_LENS} candidates. Use category exactly "${lens.category}". ` +
      "Each candidate must include a one-line summary, locations, impact on maintainability or future correctness, and an optional safe first recommendation. " +
      "Only include opportunities where a small, reviewable first step is plausible. Structured output only.",
    verifierPrompt: (candidate) =>
      `## Refactor-scout verifier\n\n${scopeBlock}\n## Candidate\n` +
      `Location: ${formatLocation(candidate)}\nCategory: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}\n` +
      `Recommendation: ${candidate.recommendation ?? "(none supplied)"}\n\n` +
      "Read the relevant files and return CONFIRMED, PLAUSIBLE, or REFUTED. " +
      "Default toward REFUTED if the opportunity is generic, too broad, not evidenced by code, or lacks a safe first step. " +
      "Evidence must quote or cite code. Structured output only.",
    makeVerified: (candidate, lens, judged): Verified => ({
      ...candidate,
      verdict: judged.verdict,
      evidence: judged.evidence,
      confidence: judged.confidence,
      lens,
    }),
  });
  rawCandidateCount += pipelineResult.rawCandidates;
  droppedCandidateCount += pipelineResult.dropped;
  refutedCandidateCount += pipelineResult.refuted;
  const verified = pipelineResult.verified;
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  progress({ type: "counter", key: "verified", label: "verified", value: verified.length });
  progress({ type: "counter", key: "kept", label: "kept", value: surviving.length });
  progress({ type: "summary", key: "verified", value: verified.length });
  progress({ type: "summary", key: "kept", value: surviving.length });
  log(`${verified.length} verified → ${surviving.length} kept`);

  if (surviving.length === 0) {
    return emptyReport("No refactor opportunities survived verification.", ["Leave the scoped code unchanged unless a human reviewer has additional context."], stats);
  }

  phase("Synthesize");
  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nSafe first step: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");

  const report = await agent(
    `## Synthesis: final refactor-scout report\n\n${ranked.length} opportunities survived independent verification.\n\n${block}\n\n` +
      "Merge findings with the same root cause and rank highest leverage / lowest risk first. " +
      "Return the shared advisory report shape. Categories should come from the verified candidates. " +
      "Severity is maintenance or future-correctness impact. Confidence is high for CONFIRMED, medium for PLAUSIBLE unless verifier confidence says otherwise. " +
      "Recommendations must be safe first refactor steps, not rewrites. Include concrete nextSteps for the host developer. Structured output only.",
    { phase: "Synthesize", label: "synthesize", thinkingLevel: "medium", schema: AdvisoryReportSchema },
  );

  if (!report) return emptyReport("Synthesis produced no output.", ["Inspect verifier evidence manually or rerun the workflow with a narrower target."], stats);

  const findings = backfillAdvisoryFindings(report.findings, ranked, {
    impact: "Impact not restated by synthesis.",
    recommendation: "Choose a small, behavior-preserving refactor first step.",
  });
  return { ...report, findings, stats };
}

function emptyReport(summary: string, nextSteps: string[], stats: WorkflowRunStats): AdvisoryReport & { stats: WorkflowRunStats } {
  return { summary, findings: [], nextSteps, stats };
}

function rank(finding: Verified): number {
  const verdictRank = finding.verdict === "CONFIRMED" ? 0 : 1;
  const categoryRank = finding.category === "dead-code" || finding.category === "conventions" ? 2 : 0;
  return verdictRank + categoryRank;
}

