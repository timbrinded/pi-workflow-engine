import { challengeFindings, parseChallengeArgs } from "../src/advisory-challenge.ts";
import { AdvisorySynthesisSchema, SYNTHESIS_ID_INSTRUCTIONS, collectAdvisoryStage, identifyCandidates, dedupeCandidates, withAdvisoryCoverage, type AdvisoryStageCoverage } from "../src/advisory-evidence.ts";
import { Type } from "typebox";
import {
  AdvisoryCandidatesSchema,
  AdvisoryVerdictSchema,
  type AdvisoryReport,
  type AdvisoryCandidate,
  type AdvisoryVerdict,
} from "../src/advisory-schema.ts";
import {
  type AdvisoryVerified,
  resolveAdvisorySynthesis,
  emptyAdvisoryReport,
  formatEvidence,
  formatLocation,
  primaryLocation,
  publishVerifiedKeptProgress,
  recordVerdictProgress,
  DEFAULT_ADVISORY_TOOL_HINTS,
  DEFAULT_ADVISORY_TOOLS,
} from "../src/workflow-advisory-utils.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "diagnose",
  description: "Advisory-only bug diagnosis: scope symptoms → competing hypotheses → independent verify → synthesize likely root causes.",
  phases: [{ title: "Scope" }, { title: "Hypothesize" }, { title: "Verify" }, { title: "Challenge" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  symptom: Type.String({ description: "Observed bug, failing command, regression, or unclear behavior." }),
  commands: Type.Array(Type.String(), { description: "Safe read-only or diagnostic commands relevant to the symptom." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files likely involved." }),
  observations: Type.Array(Type.String(), { description: "Concrete observations from files, tests, config, or command output." }),
  constraints: Type.Optional(Type.String({ description: "Safety constraints, missing evidence, or commands intentionally not run." })),
});

interface HypothesisLens {
  label: string;
  category: string;
  text: string;
}

type Candidate = AdvisoryCandidate;

interface Hypothesis extends Candidate {
  lens: HypothesisLens;
}

interface Verified extends Hypothesis {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  confidence?: AdvisoryVerdict["confidence"];
}

const HYPOTHESIS_LENSES: HypothesisLens[] = [
  { label: "recent-change", category: "regression", text: "A recent code change broke a previously working path or changed an implicit contract." },
  { label: "control-flow", category: "root-cause", text: "Incorrect branching, ordering, async flow, data flow, or state transition causes the symptom." },
  { label: "configuration", category: "configuration", text: "Configuration, environment, package scripts, or runtime assumptions differ from what the code expects." },
  { label: "dependency-api", category: "dependency", text: "A dependency API, version, import mode, or bundled peer behavior does not match the implementation." },
  { label: "test-fixture", category: "test-fixture", text: "The failure is caused by test setup, fixtures, mocks, generated files, or stale local state rather than product code." },
];

const TOOLS = DEFAULT_ADVISORY_TOOLS;
const TOOL_HINTS = DEFAULT_ADVISORY_TOOL_HINTS;
const PER_LENS = 4;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, phase, log, progress, args } = api;
  const challengeConfig = parseChallengeArgs(args);
  const symptom = challengeConfig.args.trim();
  let fileCount = 0;
  let rawCandidateCount = 0;
  let droppedCandidateCount = 0;
  let refutedCandidateCount = 0;
  const coverage: AdvisoryStageCoverage[] = [];
  let evidenceRecords: AdvisoryVerified[] = [];
  const finish = <T extends AdvisoryReport>(report: T) => ({
    ...withAdvisoryCoverage(report, coverage),
    verification: evidenceRecords,
  });
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
    "Establish the scope for an advisory-only diagnosis workflow. Do not edit files.\n" +
      (symptom
        ? `Bug / failure description (verbatim): ${symptom}\n\n`
        : "No explicit symptom was provided. Infer likely failing commands from repository manifests and scripts without running destructive commands.\n\n") +
      "Inspect relevant files, package/test configuration, and safe diagnostic commands. " +
      "Safe commands are read-only commands such as status, grep, listing files, typecheck/test commands, or commands explicitly requested by the user. " +
      "Do not run mutation, install, commit, network, or destructive commands. Return scoped files, observations, and constraints. Structured output only.",
    { phase: "Scope", label: "scope", tools: TOOLS, toolHints: TOOL_HINTS, profile: "medium", schema: ScopeSchema },
  );

  if (!scope) {
    return finish(emptyAdvisoryReport(
      "Diagnosis could not establish a scope.",
      ["Provide the failing command, error message, or regression description and rerun diagnose."],
      makeStats(0, 0),
    ));
  }

  fileCount = scope.files.length;
  progress({ type: "counter", key: "files", label: "files", value: fileCount });
  progress({ type: "summary", key: "symptom", value: scope.symptom });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") || "(none)" });
  log(`${scope.files.length} files scoped for diagnosis`);

  const scopeBlock =
    `## Symptom\n${scope.symptom}\n\n## Relevant commands\n${scope.commands.map((command) => `- ${command}`).join("\n") || "(none)"}\n\n` +
    `## Files\n${scope.files.map((file) => `- ${file}`).join("\n") || "(none)"}\n\n` +
    `## Observations\n${scope.observations.map((observation) => `- ${observation}`).join("\n") || "(none)"}\n\n` +
    `## Constraints\n${scope.constraints ?? "(none noted)"}\n`;

  phase("Hypothesize");
  const perLens = await collectAdvisoryStage(api, "Find",
    HYPOTHESIS_LENSES.map((lens) => ({ id: lens.label, run: async (): Promise<Hypothesis[]> => {
      const found = await agent(
        `## Diagnose hypothesis generator — ${lens.label}\n\n${scopeBlock}\n` +
          "This workflow is advisory-only: diagnose and recommend validation/fix plans, but do not edit files.\n" +
          `Consider ONLY this hypothesis lens:\n${lens.text}\n\n` +
          `Surface up to ${PER_LENS} root-cause hypotheses. Use category exactly "${lens.category}". ` +
          "Each hypothesis must include a one-line summary, locations, impact explaining how it produces the symptom, and an optional recommendation for the next validation step. Structured output only.",
        { phase: "Hypothesize", label: `hypothesize:${lens.label}`, tools: TOOLS, toolHints: TOOL_HINTS, profile: "small", schema: AdvisoryCandidatesSchema },
      );
      if (!found) throw new Error("Finder produced no output");
      const candidates = identifyCandidates(found.candidates.slice(0, PER_LENS), lens.label).map((candidate) => ({ ...candidate, lens }));
      rawCandidateCount += candidates.length;
      progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: candidates.length });
      for (const candidate of candidates) {
        progress({
          type: "lane_item",
          lane: "Hypotheses",
          title: candidate.summary,
          subtitle: formatLocation(candidate),
          status: "pending",
          details: candidate.impact,
        });
      }
      return candidates;
    } })), coverage,
  );

  const hypotheses = dedupe(perLens.flat(), (dropped) => {
    droppedCandidateCount += dropped;
    progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: dropped });
  });

  phase("Verify");
  const verdicts = await collectAdvisoryStage(api, "Verify",
      hypotheses.map((hypothesis) => ({ id: hypothesis.candidateId!, candidate: hypothesis, run: async (): Promise<Verified> => {
        const location = primaryLocation(hypothesis);
        const judged = await agent(
          `## Diagnose verifier\n\n${scopeBlock}\n## Hypothesis\n` +
            `Candidate record: ${JSON.stringify(hypothesis)}\nLocation: ${formatLocation(hypothesis)}\nCategory: ${hypothesis.category}\nSummary: ${hypothesis.summary}\nImpact: ${hypothesis.impact}\n` +
            `Recommended validation: ${hypothesis.recommendation ?? "(none supplied)"}\n\n` +
            "Read relevant files and, when useful, run only safe read-only diagnostic commands from the scoped command list or commands explicitly requested by the user. " +
            "Do not run mutation, install, commit, network, or destructive commands. Return CONFIRMED, PLAUSIBLE, NOT_SUBSTANTIATED, or REFUTED with evidence. " +
            "Use NOT_SUBSTANTIATED when evidence is missing; REFUTED requires disproof. Structured output only.",
          {
            phase: "Verify",
            label: `verify:${location.file.split("/").pop() ?? location.file}`,
            tools: TOOLS,
            toolHints: TOOL_HINTS,
            profile: "small",
            schema: AdvisoryVerdictSchema,
          },
        );
        if (!judged) throw new Error("Verifier produced no output");
        recordVerdictProgress(progress, hypothesis, judged, () => {
          refutedCandidateCount += 1;
        });
        return { ...hypothesis, verdict: judged.verdict, evidence: judged.evidence, confidence: judged.confidence };
      } })), coverage,
  );

  const verified = await challengeFindings(api, verdicts, scopeBlock, challengeConfig.options, coverage);
  evidenceRecords = verified;
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const refuted = verified.filter((finding) => finding.verdict === "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  publishVerifiedKeptProgress({ progress, log }, verified.length, surviving.length);

  if (surviving.length === 0) {
    return finish(emptyAdvisoryReport(
      "No root-cause hypothesis survived verification.",
      ["Capture the exact failing command and error output.", "Rerun diagnose with a narrower symptom or more evidence."],
      stats,
    ));
  }

  phase("Synthesize");
  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] IDs: ${finding.sourceCandidateIds?.join(", ")} ${formatLocation(finding)} (${finding.verdict}, ${finding.category})\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}\nValidation/fix plan: ${finding.recommendation ?? "(none supplied)"}`,
    )
    .join("\n\n");
  const refutedBlock = refuted
    .slice(0, 8)
    .map((finding) => `- ${finding.summary} — REFUTED because ${formatEvidence(finding.evidence)}`)
    .join("\n");

  const [report] = await collectAdvisoryStage(api, "Synthesize", [{ id: "synthesize", run: () => agent(
    SYNTHESIS_ID_INSTRUCTIONS + `## Synthesis: final diagnosis report\n\n${ranked.length} hypotheses survived independent verification.\n\n${block}\n\n` +
      `## Refuted hypotheses for context\n${refutedBlock || "(none recorded)"}\n\n` +
      "Select confirmed, plausible or explicitly unresolved root causes by ID. " +
      "Recommendation must be a validation/fix plan, not a patch. nextSteps must be the minimum commands or code inspections needed to confirm the top diagnosis. Structured output only.",
    {
      phase: "Synthesize",
      label: "synthesize",
      tools: [],
      profile: "medium",
      resume: "read-only",
      schema: AdvisorySynthesisSchema,
    },
  ) }], coverage);

  const resolved = resolveAdvisorySynthesis(report, ranked, {
    impact: "Impact not restated by verification.",
    recommendation: "Inspect the cited evidence and validate the smallest repair.",
  }, coverage);
  return finish({ ...resolved, stats: { ...stats, kept: resolved.findings.length } });
}

function dedupe(candidates: Hypothesis[], onDropped: (dropped: number) => void): Hypothesis[] {
  const novel = dedupeCandidates(candidates);
  const dropped = candidates.length - novel.length;
  if (dropped > 0) onDropped(dropped);
  return novel;
}

function rank(finding: Verified): number {
  if (finding.verdict === "CONFIRMED") return 0;
  return 1;
}
