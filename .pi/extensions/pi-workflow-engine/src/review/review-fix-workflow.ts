import { fileURLToPath } from "node:url";
import type { ParallelSettledError, WorkflowParallel } from "../concurrency.ts";
import type { AgentOptions, IsolatedAgentResult, LoadedWorkflow, WorkflowModule } from "../types.ts";
import type { WorktreeBaseline } from "../worktree.ts";
import { loadWorkflow } from "../workflow-module.ts";
import { formatIssueLocation, type ReviewContext, type ReviewIssue } from "./review-issues.ts";

const REVIEW_FIX_PHASE = "Generate patch previews";
const REVIEW_FIX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const REVIEW_FIX_SOURCE_PATH = fileURLToPath(import.meta.url);
const REVIEW_FIX_SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

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

type ReviewFixAgentOptions = AgentOptions & { readonly isolation: "worktree" };

export interface ReviewFixWorkflowApi {
  readonly agent: (prompt: string, options: ReviewFixAgentOptions) => Promise<IsolatedAgentResult<string>>;
  readonly parallel: WorkflowParallel;
  readonly phase: (title: string) => void;
}

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
    default: async (api) =>
      await runReviewFixWorkflow(
        {
          agent: async (prompt, options) => await api.agent(prompt, options),
          parallel: api.parallel,
          phase: api.phase,
        },
        issues,
        context,
      ),
  };
  return loadWorkflow(
    module,
    { kind: "file", path: REVIEW_FIX_SOURCE_PATH, root: REVIEW_FIX_SOURCE_ROOT },
    { isolatedWorktreeBaseline: baseline },
  );
}

export function buildFixAgentPrompt(issue: ReviewIssue, context: ReviewContext | undefined): string {
  return `Generate a patch preview for exactly one verified code-review finding in your disposable git worktree.

Selected finding JSON:
\`\`\`json
${JSON.stringify({ context, issue: toFixPromptIssue(issue) })}
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

function toFixPromptIssue(issue: ReviewIssue): object {
  return {
    id: issue.id,
    summary: issue.finding.summary,
    category: issue.finding.category,
    severity: issue.finding.severity,
    confidence: issue.finding.confidence,
    location: {
      file: issue.file,
      line: issue.line,
      symbol: issue.symbol,
      display: formatIssueLocation(issue),
    },
    impact: issue.finding.impact,
    evidence: issue.finding.evidence,
    recommendation: issue.finding.recommendation,
  };
}
