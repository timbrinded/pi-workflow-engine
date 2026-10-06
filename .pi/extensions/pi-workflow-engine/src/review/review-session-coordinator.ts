import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "../session-identity.ts";
import { resolveWorkflowRunOptions, type ResolvedWorkflowRunOptions } from "../options.ts";
import type { LoadedWorkflow } from "../types.ts";
import type { WorkflowResultEnvelope } from "../workflow-execution.ts";
import { handleReviewViewerAction } from "./review-actions.ts";
import { ReviewFixBudgetLedger } from "./review-budget.ts";
import { toReviewIssues, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { showReviewResultsViewer } from "./review-results-viewer.ts";
import { isReviewReport, type ReviewReport } from "./review-report.ts";

export interface RetainedCodeReviewResult {
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
  ) => Promise<WorkflowResultEnvelope>;
  readonly publish: (envelope: WorkflowResultEnvelope) => void;
}

/** Owns retained code-review state and every path that presents or acts on it. */
export class ReviewSessionCoordinator {
  private readonly sessions = new Map<string, RetainedCodeReviewResult>();

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendUserMessage" | "exec">,
    private readonly dependencies: ReviewSessionCoordinatorDependencies,
  ) {}

  /** Retains a code-review result for this session and returns it; any other result retains nothing. */
  remember(
    ctx: ExtensionContext,
    envelope: WorkflowResultEnvelope,
    options: ResolvedWorkflowRunOptions,
  ): RetainedCodeReviewResult | undefined {
    if (envelope.name !== "code-review") return undefined;
    const key = sessionKey(ctx);
    const report = envelope.result;
    if (!isReviewReport(report)) {
      this.sessions.delete(key);
      return undefined;
    }
    const retained: RetainedCodeReviewResult = {
      report,
      concurrency: options.concurrency,
      parallelSubmissionLimit: options.parallelSubmissionLimit ?? undefined,
      perf: options.perf,
      budget: new ReviewFixBudgetLedger(options.budget, envelope.usage),
    };
    this.sessions.set(key, retained);
    return retained;
  }

  /** Opens the findings viewer for a result remember() just retained, when explicitly requested. */
  async present(
    ctx: ExtensionContext,
    retained: RetainedCodeReviewResult | undefined,
    options: ResolvedWorkflowRunOptions,
  ): Promise<void> {
    if (!retained || retained.report.findings.length === 0) return;
    if (options.resultViewer !== "open" || ctx.mode !== "tui" || !ctx.hasUI) return;
    await this.openAndHandle(ctx, retained);
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

    await this.openAndHandle(ctx, retained);
  }

  dispose(ctx: ExtensionContext): void {
    this.sessions.delete(sessionKey(ctx));
  }

  private async openAndHandle(ctx: ExtensionContext, retained: RetainedCodeReviewResult): Promise<void> {
    const issues = toReviewIssues(retained.report);
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
      const envelope = await this.dependencies.runFollowUp(ctx, followUp, followUpOptions(retained, ctx.signal));
      this.dependencies.publish(envelope);
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
