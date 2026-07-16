import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "../cancellation.ts";
import type { LoadedWorkflow } from "../types.ts";
import type { WorktreeBaseline } from "../worktree.ts";
import { postInlineComments, resolveGitHubPrContext, type ExecLike, type InlineCommentStatus } from "./github-pr-comments.ts";
import { createReviewFixWorkflow } from "./review-fix-workflow.ts";
import { buildCommentHandoffPrompt } from "./review-handoff.ts";
import { isCommentableIssue, type ReviewContext, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { resolveReviewWorktreeBaseline } from "./review-snapshot.ts";

export type ReviewActionPi = Pick<ExtensionAPI, "sendUserMessage" | "exec">;
export interface ReviewActionContext {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly ui: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export type ReviewBaselineResolver = (
  context: ReviewContext | undefined,
  cwd: string,
  signal?: AbortSignal,
) => Promise<WorktreeBaseline>;

export async function handleReviewViewerAction(
  pi: ReviewActionPi,
  ctx: ReviewActionContext,
  action: ReviewIssueSelection | undefined,
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  resolveBaseline: ReviewBaselineResolver = resolveReviewWorktreeBaseline,
): Promise<LoadedWorkflow | undefined> {
  if (!action || action.action === "close") return;
  const selected = selectedIssues(issues, action.issueIds);
  if (action.action === "fix") {
    return await handleFixAction(ctx, selected, context, resolveBaseline);
  }
  await handleCommentAction(pi, ctx, selected, context);
}

async function handleFixAction(
  ctx: ReviewActionContext,
  selected: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  resolveBaseline: ReviewBaselineResolver,
): Promise<LoadedWorkflow | undefined> {
  throwIfAborted(ctx.signal);
  if (selected.length === 0) {
    ctx.ui.notify("No selected findings to fix", "warning");
    return;
  }
  ctx.ui.notify("Verifying the reviewed snapshot before generating patch previews", "info");
  let baseline: WorktreeBaseline;
  try {
    baseline = await resolveBaseline(context, ctx.cwd, ctx.signal);
  } catch (error) {
    throwIfAborted(ctx.signal);
    ctx.ui.notify(formatError(error), "warning");
    return;
  }
  ctx.ui.notify(`Generating isolated patch previews for ${selected.length} selected finding(s)`, "info");
  return createReviewFixWorkflow(selected, context, baseline);
}

async function handleCommentAction(
  pi: ReviewActionPi,
  ctx: ReviewActionContext,
  selected: readonly ReviewIssue[],
  context: ReviewContext | undefined,
): Promise<void> {
  const commentable = selected.filter(isCommentableIssue);
  if (commentable.length === 0) {
    ctx.ui.notify("No selected findings have file and line information for inline PR comments", "warning");
    return;
  }

  const confirmed = await ctx.ui.confirm(
    "Post inline PR comments?",
    `Post ${commentable.length} selected finding(s) to the upstream PR using GitHub CLI if available?`,
  );
  if (!confirmed) {
    queueCommentFallback(pi, ctx, commentable, context, "User chose parent-agent fallback instead of direct gh posting.");
    return;
  }

  const exec = toExecLike(pi);
  const resolved = await resolveGitHubPrContext(exec, ctx.cwd, context);
  if (!resolved.ok) {
    queueCommentFallback(pi, ctx, commentable, context, resolved.reason);
    return;
  }

  const statuses = await postInlineComments(exec, ctx.cwd, resolved.context, commentable);
  const summary = summarizeStatuses(statuses);
  ctx.ui.notify(`PR comments: ${summary.posted} posted, ${summary.skipped} skipped, ${summary.failed} failed`, summary.failed > 0 ? "warning" : "info");
  if (summary.failed > 0) {
    const failedIds = new Set(statuses.filter((status) => status.status === "failed").map((status) => status.issueId));
    queueCommentFallback(
      pi,
      ctx,
      commentable.filter((issue) => failedIds.has(issue.id)),
      context,
      "Direct gh posting failed for one or more selected findings.",
    );
  }
}

function queueCommentFallback(
  pi: ReviewActionPi,
  ctx: ReviewActionContext,
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  reason: string,
): void {
  if (issues.length === 0) return;
  pi.sendUserMessage(buildCommentHandoffPrompt(issues, context, reason), { deliverAs: "followUp" });
  ctx.ui.notify(`Queued PR comment request for ${issues.length} selected finding(s)`, "info");
}

function toExecLike(pi: ReviewActionPi): ExecLike {
  return async (command, args, options) => await pi.exec(command, args, options);
}

function selectedIssues(issues: readonly ReviewIssue[], issueIds: readonly string[]): ReviewIssue[] {
  const selected = new Set(issueIds);
  return issues.filter((issue) => selected.has(issue.id));
}

function summarizeStatuses(statuses: readonly InlineCommentStatus[]): { readonly posted: number; readonly skipped: number; readonly failed: number } {
  let posted = 0;
  let skipped = 0;
  let failed = 0;
  for (const status of statuses) {
    if (status.status === "posted") posted++;
    else if (status.status === "skipped") skipped++;
    else failed++;
  }
  return { posted, skipped, failed };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
