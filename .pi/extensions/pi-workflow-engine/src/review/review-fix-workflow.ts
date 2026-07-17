import type { ParallelSettledError } from "../concurrency.ts";
import type { LoadedWorkflow, WorkflowApi, WorkflowModule } from "../types.ts";
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

export type ReviewFixWorkflowApi = Pick<WorkflowApi, "agent" | "parallel" | "phase">;

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
      phases: [{ title: REVIEW_FIX_PHASE }],
    },
    default: (api) => runReviewFixWorkflow(api, issues, context),
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
): Promise<ReviewFixWorkflowResult> {
  api.phase(REVIEW_FIX_PHASE);
  const settled = await api.parallel(
    issues.map((issue) => async (): Promise<ReviewFixPreview> => {
      const isolated = await api.agent(buildFixAgentPrompt(issue, context), {
        isolation: "worktree",
        label: `fix:${issue.id}`,
        phase: REVIEW_FIX_PHASE,
        thinkingLevel: "medium",
        cacheKey: `review-fix:${issue.id}`,
        tools: [...REVIEW_FIX_TOOLS],
        toolHints: ["search"],
      });
      return {
        findingId: issue.id,
        result: isolated.result,
        patch: isolated.patch,
        changed: isolated.changed,
      };
    }),
    { settled: true },
  );

  const fixes = settled.map((entry, index): ReviewFixOutcome =>
    entry.ok ? entry.value : { findingId: issues[index]!.id, error: entry.error },
  );
  const successful = fixes.filter(isReviewFixPreview);
  const changed = successful.filter((fix) => fix.changed).length;
  const failed = fixes.length - successful.length;

  return {
    summary: `Generated ${changed} patch preview(s); ${successful.length - changed} finding(s) needed no changes; ${failed} attempt(s) failed.`,
    fixes,
  };
}

function isReviewFixPreview(outcome: ReviewFixOutcome): outcome is ReviewFixPreview {
  return "patch" in outcome;
}
