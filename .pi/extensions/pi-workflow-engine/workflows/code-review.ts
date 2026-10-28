import { challengeFindings, parseChallengeArgs } from "../src/advisory-challenge.ts";
import { Type, type Static } from "typebox";
import {
  type AdvisoryVerified,
  type AdvisoryLens,
  concludeLensReview,
  emptyAdvisoryReport,
  finishAdvisoryReport,
  formatEvidence,
  formatLocation,
  runLensVerificationPipeline,
  verifierCandidates,
  EMPTY_LENS_REVIEW_STATS,
  verdictConfidence,
  DEFAULT_ADVISORY_TOOL_HINTS,
  DEFAULT_ADVISORY_TOOLS,
} from "../src/workflow-advisory-utils.ts";
import { formatReviewDiffTarget, parseAllowedDiffCommand } from "../src/review-diff-target.ts";
import { changedLines, diffAnchor } from "../src/review/review-diff-lines.ts";
import type { ReviewContext } from "../src/review/review-report.ts";
import { captureReviewMaterial } from "../src/review/review-snapshot.ts";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "code-review",
  description: "Fan-out review of the branch's open PR (or branch vs main): scope → per-angle find → independent verify → synthesize.",
  whenToUse: "Use to review a PR, branch diff, ref range, or focused target for correctness bugs and cleanups, with every finding independently verified; args are the target or review instructions, blank auto-detects the diff.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Challenge" }, { title: "Synthesize" }],
};

// ─── Schemas (the contracts that make orchestration plain code) ───
const ScopeSchema = Type.Object({
  diffCommand: Type.String({ description: "Exact git command that produces the review diff" }),
  files: Type.Array(Type.String(), { description: "Changed file paths" }),
  summary: Type.String({ description: "One-paragraph summary of the change" }),
  conventions: Type.Optional(Type.String({ description: "Relevant AGENTS.md / project conventions" })),
});

// With review instructions, scope splits them by stage: finders get only where to look, because a reporting bar in a
// finder prompt makes finders filter their own candidates before any verifier sees them; the bar goes to synthesis.
const InstructedScopeSchema = Type.Object({
  ...ScopeSchema.properties,
  conventions: Type.Optional(Type.String({ description: "Repository conventions from AGENTS.md and project docs only. Do not restate the user's review instructions, filtering rules or already-reported findings here." })),
  focus: Type.String({ description: "Where the user wants reviewers to look: areas, files, risks and lenses named in the instructions. Exclude any filtering, evidence, reporting or deduplication rules; write (none) if the instructions name no focus." }),
  reportingBar: Type.String({ description: "The user's filtering, evidence, severity and reporting rules restated so a reader without file access can apply them, listing every already-reported issue to exclude (read any files the instructions reference). Write (none) if the instructions set no bar." }),
});
type Scope = Static<typeof ScopeSchema> & Partial<Pick<Static<typeof InstructedScopeSchema>, "focus" | "reportingBar">>;

// The review lenses — this is the part you customise to your codebase's real failure modes.
const ANGLES: AdvisoryLens[] = [
  { label: "logic-bugs", category: "bug", text: "Off-by-one errors, wrong conditionals, incorrect return values, broken control flow." },
  { label: "error-paths", category: "bug", text: "Unhandled errors, swallowed exceptions, missing awaits, partial failure leaving inconsistent state." },
  { label: "edge-cases", category: "bug", text: "Empty/null inputs, boundary values, concurrency races, resource leaks." },
  { label: "simplification", category: "cleanup", text: "Dead code, needless complexity, duplicated logic, clearer equivalents." },
  { label: "conventions", category: "cleanup", text: "Violations of the project conventions noted in scope (naming, idioms, banned patterns)." },
];

const PER_ANGLE = 6;

const DIFF_EMBED_CAP = 60_000;

export function buildCodeReviewScopeBlock(input: {
  readonly diffCommand: string;
  readonly files: readonly string[];
  readonly summary: string;
  readonly conventions?: string;
  readonly diffText: string;
  readonly instructions?: { readonly heading: string; readonly text: string };
}): string {
  const diffBlock = input.diffText
    ? `\n## Diff (review is bounded to these changed lines)\n\`\`\`diff\n${
        input.diffText.length > DIFF_EMBED_CAP
          ? `${input.diffText.slice(0, DIFF_EMBED_CAP)}\n... (truncated — run \`${input.diffCommand}\` for the full diff)`
          : input.diffText
      }\n\`\`\`\n`
    : "";
  return (
    `## Diff command\n${input.diffCommand}\n\n## Changed files\n${input.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Summary\n${input.summary}\n\n## Conventions\n${input.conventions ?? "(none noted)"}\n` +
    diffBlock +
    (input.instructions?.text ? `\n## ${input.instructions.heading}\n${input.instructions.text}\n` : "")
  );
}

export interface CodeReviewDependencies {
  readonly captureReviewMaterial?: typeof captureReviewMaterial;
}

export default async function run(api: WorkflowApi, dependencies: CodeReviewDependencies = {}): Promise<unknown> {
  const { agent, phase, log, progress, args, cwd, signal } = api;
  const challengeConfig = parseChallengeArgs(args);
  const target = challengeConfig.args;

  // ─── Phase 0: Scope ───
  phase("Scope");
  const scopePrompt =
    "Establish the scope of a code review.\n" +
      (target
        ? `Target / instructions (verbatim): "${target}". If it names a PR number, branch, ref range, or files, build the matching diff command (use 'gh pr diff <number>' for a PR). Otherwise use the default selection below.\n`
        : "No explicit target — select the diff to review using the default below.\n") +
      "Canonical Git syntax: use `git diff -- <path> [<path>...]` for file paths; use one `A..B` or `A...B` range operand for two revisions. Never emit ambiguous two-operand forms such as `git diff A B`.\n" +
      "Default selection — run commands to decide, falling through until you get a NON-EMPTY diff:\n" +
      "1. Get the current branch: `git branch --show-current`.\n" +
      "2. Check for an OPEN GitHub PR for this branch: `gh pr list --head <branch> --state open --json number,title`. " +
      "If one exists, the diff command is `gh pr diff <number>` — note the PR number and title in the summary.\n" +
      "3. If there is no open PR (or `gh` is unavailable / there is no GitHub remote), diff the branch against its base: " +
      "prefer `git diff main...HEAD`, then `git diff master...HEAD`, then `git diff HEAD~1`. " +
      "If the branch itself is main/master, use `git diff HEAD~1`.\n" +
      "4. Run the chosen command to confirm the diff is non-empty.\n\n" +
      "Then: list the changed files, summarize the change in one paragraph (mention the PR if one was found), " +
      "and read any relevant AGENTS.md or project docs noting conventions a reviewer should know.\n" +
      "Return diffCommand exactly as a reviewer should run it. Structured output only.";
  const scopeOptions = { phase: "Scope", label: "scope", tools: DEFAULT_ADVISORY_TOOLS, toolHints: DEFAULT_ADVISORY_TOOL_HINTS, profile: "medium" } as const;
  const scope: Scope = target
    ? await agent(
        `${scopePrompt}\nKeep the user's instructions out of conventions. Return focus (where to look) and reportingBar (the self-contained filtering and reporting bar, with every already-reported issue spelled out) as separate fields.`,
        { ...scopeOptions, schema: InstructedScopeSchema },
      )
    : await agent(scopePrompt, { ...scopeOptions, schema: ScopeSchema });

  progress({ type: "summary", key: "files", value: scope.files.join(", ") || "(none)" });
  const diffTarget = parseAllowedDiffCommand(scope.diffCommand);
  if ("error" in diffTarget) {
    throw new Error(`Code-review target rejected: ${diffTarget.error}`);
  }
  const diffCommand = formatReviewDiffTarget(diffTarget);
  progress({ type: "summary", key: "diffCommand", value: diffCommand });
  progress({ type: "counter", key: "files", label: "files", value: scope.files.length });
  const noChanges = (summary: string, nextSteps = ["Provide a PR, ref range, or changed files to review."]) =>
    finishAdvisoryReport(emptyAdvisoryReport(summary, nextSteps, { ...EMPTY_LENS_REVIEW_STATS, files: scope.files.length }), []);

  if (scope.files.length === 0) return noChanges("No changes found to review.");

  log(`${scope.files.length} changed files`);

  // Capture the diff once, deterministically, so findings can be bounded to changed lines in code.
  const reviewMaterial = await (dependencies.captureReviewMaterial ?? captureReviewMaterial)(diffTarget, cwd, signal);
  if (!reviewMaterial.ok) {
    throw new Error(`Code-review diff capture failed: ${reviewMaterial.error}`);
  }
  const diffText = reviewMaterial.diff;
  const changed = changedLines(diffText);
  progress({ type: "summary", key: "diffBytes", value: Buffer.byteLength(diffText) });
  // Findings anchor only on files with a new-side text hunk; without one, skip the finder fan-out.
  if (changed.size === 0) {
    if (!diffText.trim()) return noChanges(`No changes found to review: \`${diffCommand}\` has no added or modified files.`);
    return noChanges(
      `Nothing to review line by line: \`${diffCommand}\` only deletes or renames files, changes file modes, or touches binary files; there are no added lines to anchor findings on.`,
      ["Inspect the deleted, renamed, mode-changed or binary files directly; code-review anchors findings on added lines only."],
    );
  }
  if (reviewMaterial.snapshot.status === "unavailable") {
    log(`review snapshot unavailable (${reviewMaterial.snapshot.reason}) — patch previews will be unavailable`);
  }

  const reviewContext: ReviewContext = {
    workflowName: "code-review",
    target,
    diffTarget,
    files: scope.files,
    summary: scope.summary,
    ...(reviewMaterial.snapshot.status === "verified"
      ? { snapshot: reviewMaterial.snapshot.identity }
      : {}),
  };

  const blockFor = (instructions?: { heading: string; text: string }) =>
    `Reviewed snapshot identity: ${JSON.stringify(reviewContext.snapshot ?? "unavailable")}\n` + buildCodeReviewScopeBlock({
      diffCommand,
      files: scope.files,
      summary: scope.summary,
      conventions: scope.conventions,
      diffText,
      ...(instructions ? { instructions } : {}),
    });
  const scopeBlock = blockFor({ heading: "User instructions (verbatim)", text: target });
  const focus = stated(scope.focus);
  const reportingBar = stated(scope.reportingBar);
  const finderBlock = blockFor(focus ? { heading: "Review focus (from the user's instructions)", text: focus } : undefined);
  if (focus) log(`review focus: ${focus}`);

  const pipelineResult = await runLensVerificationPipeline({
    api,
    lenses: ANGLES,
    perLens: PER_ANGLE,
    // Finders on `small` (thinking low by default) returned nothing on real PRs; they are the stage that must dig.
    finderProfile: "medium",
    verifierCategories: ["bug", "cleanup"],
    boundCandidate: (candidate, lens) => {
      const reviewAnchor = candidate.reviewAnchor
        ? diffAnchor(changed, candidate.reviewAnchor)
        : candidate.locations.map((location) => diffAnchor(changed, location)).find((anchor) => anchor !== undefined);
      return reviewAnchor ? { ...candidate, category: lens.category, reviewAnchor } : undefined;
    },
    finderPrompt: (lens) =>
      `## Code-review finder — ${lens.label}\n\n${finderBlock}\n` +
      `Review the change through ONLY this lens:\n${lens.text}\n` +
      "Only flag issues on lines that are part of the diff above (run the diff command if it is not shown). " +
      "Set reviewAnchor to the changed line causing the issue; locations and discoveryEvidence may include unchanged callers and other files. " +
      `Surface up to ${PER_ANGLE} candidates. Use initial category "${lens.category}"; verification will classify the actual failure mode independently of this lens. Each candidate must include a one-line summary, ` +
      "locations with the changed file and a line that appears in the diff, and impact describing the concrete failure or maintenance scenario. " +
      "Pass through anything with a nameable impact — a separate verifier judges them next. Structured output only.",
    verifierPrompt: (candidates) =>
      `## Code-review verifier\n\n${scopeBlock}\n` +
      verifierCandidates(candidates, { one: "Candidate", many: "Candidates" }, (candidate) =>
        `Location: ${formatLocation(candidate)}\nCategory: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}`) + "\n\n" +
      "Run the diff command, read the relevant file(s), and return exactly one verdict per candidate (CONFIRMED / PLAUSIBLE / NOT_SUBSTANTIATED / REFUTED) " +
      "with evidence quoting the line(s). Also classify each candidate as bug (a behavioral correctness failure) or cleanup (maintenance-only improvement), based on the evidence, not its discovery lens or initial category. " +
      "A reproduced behavioral failure is a bug even when a simplification or conventions lens found it. Justify the classification in evidence. " +
      "Use NOT_SUBSTANTIATED when evidence is insufficient; use REFUTED only for concrete disproof. Structured output only.",
  });
  const verified = await challengeFindings(api, pipelineResult.verified, scopeBlock, challengeConfig.options, pipelineResult.coverage);
  const report = await concludeLensReview(api, pipelineResult, verified, {
    files: scope.files.length,
    rank,
    formatFinding: (finding, index) =>
      `### [${index}] IDs: ${finding.sourceCandidateIds.join(", ")} ${formatLocation(finding)} (${finding.verdict}${finding.category === "cleanup" ? ", cleanup" : ""})\n` +
      `Category: ${finding.category}\nConfidence: ${verdictConfidence(finding.verdict)}\n` +
      `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}`,
    empty: { summary: "No findings survived verification.", nextSteps: ["No code-review action is recommended from this workflow run."] },
    synthesisPrompt: (block, ranked) =>
      `## Synthesis: final code-review report\n\n${ranked.length} findings survived independent verification.\n\n${block}\n\n` +
      "Merge findings with the same root cause, rank most-severe first (correctness bugs above cleanups), and produce the final advisory report. " +
      "Return summary, ID selections with severity (low/medium/high) and advisory recommendation, and nextSteps. Evidence and confidence are reconstructed from verified records. Structured output only." +
      // Only a stated bar filters: a focus alone must not drop verified findings outside it.
      (reportingBar
        ? `\n\n## Reporting bar (the user's rules with referenced context resolved)\n${reportingBar}` +
          `\n\n## User instructions (verbatim)\n${target}\n\n` +
          "Apply the reporting bar to the verified categories when choosing which IDs to report; cleanup-only rules apply only to findings verified as cleanup. Leave out findings it excludes, and say in the summary what you left out and why."
        : ""),
  });
  return { ...report, reviewContext };
}

/** A scope field's text, or undefined when the scope agent left it blank or wrote (none). */
function stated(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text && text !== "(none)" ? text : undefined;
}

function rank(finding: AdvisoryVerified): number {
  return (finding.category === "cleanup" ? 2 : 0) + (finding.verdict !== "CONFIRMED" ? 1 : 0);
}
