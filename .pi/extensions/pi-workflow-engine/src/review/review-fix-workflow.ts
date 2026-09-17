import { initialPatchValidation, PatchEvaluationSchema, validateCandidatePatch, type PatchValidation } from "./patch-validation.ts";
import { isFatalWorkflowError } from "../cancellation.ts";
import { unknownErrorMessage } from "../unknown-error.ts";
import type { ParallelSettledError } from "../concurrency.ts";
import type { IsolatedAgentResult, LoadedWorkflow, WorkflowApi, WorkflowModule } from "../types.ts";
import type { WorktreeBaseline } from "../worktree.ts";
import { loadWorkflow } from "../workflow-module.ts";
import { serializeReviewIssue, type ReviewIssue } from "./review-issues.ts";
import type { ReviewContext } from "./review-report.ts";
import { serializeReviewContext } from "./review-report.ts";

const REVIEW_FIX_PHASE = "Generate patch previews";
const REVIEW_FIX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

export interface ReviewFixPreview {
  readonly findingId: string;
  readonly result: string;
  readonly patch: string;
  readonly changed: boolean;
  readonly validation: PatchValidation;
}

export interface ReviewFixFailure {
  readonly findingId: string;
  readonly error: ParallelSettledError;
}

export type ReviewFixOutcome = ReviewFixPreview | ReviewFixFailure;

export interface ReviewFixWorkflowResult {
  readonly summary: string;
  readonly fixes: readonly ReviewFixOutcome[];
}

export type ReviewFixWorkflowApi = Pick<WorkflowApi, "agent" | "parallel" | "phase" | "cwd" | "signal">;

/** Build an ephemeral workflow that generates one isolated patch preview per finding. */
export function createReviewFixWorkflow(
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  baseline: WorktreeBaseline,
): LoadedWorkflow {
  const module: WorkflowModule = {
    meta: {
      name: "code-review-fix-previews",
      description: "Generate isolated patch previews for selected code-review findings.",
      phases: [{ title: REVIEW_FIX_PHASE }, { title: "Validate patch previews" }],
    },
    default: (api) => runReviewFixWorkflow(api, issues, context, baseline),
  };
  return loadWorkflow(
    module,
    {
      kind: "unverifiable",
      reason: "ephemeral review-fix workflows capture runtime findings and do not have immutable module provenance",
    },
    baseline,
  );
}

export function buildFixAgentPrompt(issue: ReviewIssue, context: ReviewContext | undefined): string {
  return `Generate a patch preview for exactly one verified code-review finding in your disposable git worktree.

Selected finding JSON:
\`\`\`json
${JSON.stringify({ context: serializeReviewContext(context), issue: serializeReviewIssue(issue) })}
\`\`\`

Instructions:
- Inspect the finding and cited evidence before editing.
- Make the smallest edit that addresses only this finding.
- Preserve unrelated user changes and avoid broad refactors.
- Run focused validation if an appropriate local check is available.
- Do not create commits or branches; the engine captures your worktree diff automatically.
- Do not post GitHub PR comments or any upstream review comments.
- Finish with a concise summary of changed files and validation results; this text is returned alongside the captured patch.`;
}

export async function runReviewFixWorkflow(
  api: ReviewFixWorkflowApi,
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  baseline: WorktreeBaseline,
): Promise<ReviewFixWorkflowResult> {
  api.phase(REVIEW_FIX_PHASE);
  const settled = await api.parallel(
    issues.map((issue) => async (): Promise<ReviewFixPreview> => {
      const isolated = await api.agent(buildFixAgentPrompt(issue, context), {
        isolation: "worktree",
        label: `fix:${issue.id}`,
        phase: REVIEW_FIX_PHASE,
        profile: "medium",
        cacheKey: `review-fix:${issue.id}`,
        tools: [...REVIEW_FIX_TOOLS],
        toolHints: ["search"],
      });
      const validation = await evaluateReviewFix(api, { issue, context, baseline, isolated });
      return {
        findingId: issue.id,
        result: isolated.result,
        patch: isolated.patch,
        changed: isolated.changed,
        validation,
      };
    }),
    { settled: true },
  );

  const fixes = settled.map((entry, index): ReviewFixOutcome =>
    entry.ok ? entry.value : { findingId: issues[index]!.id, error: entry.error },
  );
  const successful = fixes.filter(isReviewFixPreview);
  const count = (status: PatchValidation["status"]) => successful.filter((fix) => fix.validation.status === status).length;
  const failed = fixes.length - successful.length;

  return {
    summary: `${count("verified")} verified candidate(s); ${count("rejected")} rejected; ${count("blocked")} blocked; ${count("no-patch")} no-patch; ${failed} attempt(s) failed.`,
    fixes,
  };
}

function isReviewFixPreview(outcome: ReviewFixOutcome): outcome is ReviewFixPreview {
  return "patch" in outcome;
}

async function evaluateReviewFix(api: ReviewFixWorkflowApi, input: {
  issue: ReviewIssue; context: ReviewContext | undefined; baseline: WorktreeBaseline; isolated: IsolatedAgentResult<string>;
}): Promise<PatchValidation> {
  const { issue, context, baseline, isolated } = input;
  const validation = initialPatchValidation(baseline, isolated.baselineOid, isolated.patch);
  if (!isolated.patch.trim()) return validation;
  if (!isolated.baselineOid) return { ...validation, reason: "Candidate has no recorded baseline identity." };
  if (!context?.snapshot) return { ...validation, reason: "Reviewed snapshot identity is unavailable." };
  if (validation.baselineFingerprint !== context.snapshot.baselineFingerprint) {
    return { ...validation, status: "rejected", reason: "Stale reviewed baseline identity." };
  }
  try {
    const evaluated = await api.agent(
      `Independently evaluate a candidate repair. Your fresh worktree contains the exact reviewed baseline plus the captured patch. The implementer's report is not validation evidence. Inspect the finding, callers and tests. Reject incorrect repairs; return blocked if required validation is unavailable. Select at most six focused deterministic checks with executable and argument arrays. Require at least one meaningful behavior check. If a regression test is applicable, supply a test-only baselinePatch and specific expectedFailure so the engine can prove it fails before the repair and passes after. Do not edit, install dependencies, commit or change branches. The engine will execute checks independently.\nFinding: ${JSON.stringify(serializeReviewIssue(issue))}\nBaseline: ${isolated.baselineOid}\nPatch SHA-256: ${validation.patchHash}\nPatch:\n${isolated.patch}`,
      { isolation: "worktree", candidatePatch: { baselineOid: isolated.baselineOid, patch: isolated.patch },
        label: `evaluate:${issue.id}`, phase: "Validate patch previews", profile: "medium", resume: "off",
        tools: ["read", "bash", "grep", "find", "ls"], toolHints: ["search"], schema: PatchEvaluationSchema },
    );
    if (evaluated.baselineOid !== isolated.baselineOid || evaluated.patch !== isolated.patch) {
      return { ...validation, status: "rejected", reason: "Evaluator changed the candidate or used a different baseline.", evaluation: evaluated.result };
    }
    return await validateCandidatePatch({ cwd: api.cwd, baseline, expectedFingerprint: context.snapshot.baselineFingerprint,
        baselineOid: isolated.baselineOid, patch: isolated.patch, evaluation: evaluated.result, signal: api.signal });
  } catch (error) {
    if (isFatalWorkflowError(error, api.signal)) throw error;
    return { ...validation, status: "blocked", reason: unknownErrorMessage(error) };
  }
}
