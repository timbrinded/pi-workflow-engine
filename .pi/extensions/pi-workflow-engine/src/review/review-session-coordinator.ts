import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "../session-identity.ts";
import { resolveWorkflowRunOptions, type ResolvedWorkflowRunOptions } from "../options.ts";
import type { LoadedWorkflow } from "../types.ts";
import type { WorkflowExecution } from "../workflow-execution.ts";
import { handleReviewViewerAction } from "./review-actions.ts";
import { ReviewFixBudgetLedger } from "./review-budget.ts";
import { toReviewIssues, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { codeReviewReport, decideReviewResultsPresentation, showReviewResultsViewer } from "./review-results-flow.ts";
import type { ReviewReport } from "./review-report.ts";

interface RetainedCodeReviewResult {
  readonly report: ReviewReport;
  readonly concurrency: number;
  readonly parallelSubmissionLimit?: number;
  readonly perf: boolean;
  readonly budget: ReviewFixBudgetLedger;
}

export interface ReviewSessionCoordinatorDependencies {
  readonly runFollowUp: (
    ctx: ExtensionContext,
    workflow: LoadedWorkflow,
    options: ResolvedWorkflowRunOptions,
  ) => Promise<WorkflowExecution>;
  readonly publish: (execution: WorkflowExecution) => void;
}

/** Owns retained code-review state and every path that presents or acts on it. */
export class ReviewSessionCoordinator {
  private readonly sessions = new Map<string, RetainedCodeReviewResult>();

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendUserMessage" | "exec">,
    private readonly dependencies: ReviewSessionCoordinatorDependencies,
  ) {}

  remember(
    ctx: ExtensionContext,
    execution: WorkflowExecution,
    options: ResolvedWorkflowRunOptions,
  ): void {
    const name = execution.envelope.name;
    if (name !== "code-review") return;
    const key = sessionKey(ctx);
    const report = codeReviewReport(name, execution.envelope.result);
    if (!report) {
      this.sessions.delete(key);
      return;
    }
    this.sessions.set(key, {
      report,
      concurrency: options.concurrency,
      parallelSubmissionLimit: options.parallelSubmissionLimit ?? undefined,
      perf: options.perf,
      budget: new ReviewFixBudgetLedger(options.budget, execution.envelope.usage),
    });
  }

  async present(
    ctx: ExtensionContext,
    execution: WorkflowExecution,
    options: ResolvedWorkflowRunOptions,
  ): Promise<void> {
    const name = execution.envelope.name;
    const decision = decideReviewResultsPresentation({
      workflowName: name,
      result: execution.envelope.result,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      resultViewer: options.resultViewer,
    });
    if (decision.kind !== "open") return;

    const retained = this.sessions.get(sessionKey(ctx));
    if (!retained) return;
    await this.openAndHandle(ctx, retained, decision.issues);
  }

  async reopen(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify("Code-review results viewer requires the TUI", "warning");
      return;
    }
    const retained = this.sessions.get(sessionKey(ctx));
    if (!retained) {
      ctx.ui.notify("No code-review result is available yet. Run /workflow code-review first.", "warning");
      return;
    }
    if (retained.report.findings.length === 0) {
      ctx.ui.notify("The last code review had no findings", "info");
      return;
    }

    await this.openAndHandle(ctx, retained, toReviewIssues("code-review", retained.report));
  }

  dispose(ctx: ExtensionContext): void {
    this.sessions.delete(sessionKey(ctx));
  }

  private async openAndHandle(
    ctx: ExtensionContext,
    retained: RetainedCodeReviewResult,
    issues: readonly ReviewIssue[],
  ): Promise<void> {
    let action: ReviewIssueSelection | undefined;
    try {
      action = await showReviewResultsViewer(ctx, issues);
    } catch {
      ctx.ui.notify("Review completed, but the findings viewer could not be opened.", "warning");
      return;
    }
    await this.runAction(ctx, retained, action, issues);
  }

  private async runAction(
    ctx: ExtensionContext,
    retained: RetainedCodeReviewResult,
    action: ReviewIssueSelection | undefined,
    issues: readonly ReviewIssue[],
  ): Promise<void> {
    const lease = action?.action === "fix" ? retained.budget.acquire() : undefined;
    if (lease && !lease.ok) {
      const message = lease.reason === "exhausted"
        ? "Review-fix previews are unavailable because this review's output-token budget is exhausted."
        : "A review-fix preview is already running for this review.";
      ctx.ui.notify(message, "warning");
      return;
    }

    try {
      const followUp = await handleReviewViewerAction(this.pi, ctx, action, issues, retained.report.reviewContext);
      if (!followUp) return;
      const execution = await this.dependencies.runFollowUp(ctx, followUp, followUpOptions(retained, ctx.signal));
      this.dependencies.publish(execution);
    } finally {
      if (lease?.ok) lease.release();
    }
  }
}

function followUpOptions(retained: RetainedCodeReviewResult, signal: AbortSignal | undefined): ResolvedWorkflowRunOptions {
  return resolveWorkflowRunOptions({
    concurrency: retained.concurrency,
    parallelSubmissionLimit: retained.parallelSubmissionLimit,
    budget: retained.budget.remaining,
    perf: retained.perf,
    resultViewer: "skip",
    signal,
    onUsageSnapshot: (usage) => retained.budget.record(usage),
  }, {});
}
