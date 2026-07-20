import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunOptions } from "../types.ts";
import { toReviewIssues, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { isReviewReport, type ReviewReport } from "./review-report.ts";
import { ReviewResultsViewer } from "./review-results-viewer.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "../ui/workflow-viewer-layout.ts";

export type ReviewResultsPresentationDecision =
  | {
      readonly kind: "send";
      readonly reason: "not-code-review" | "not-advisory" | "no-findings" | "disabled" | "not-tui" | "not-requested";
    }
  | { readonly kind: "open"; readonly issues: readonly ReviewIssue[] };

export interface ReviewResultsDecisionInput {
  readonly workflowName: string;
  readonly result: unknown;
  readonly mode?: string;
  readonly hasUI: boolean;
  readonly resultViewer?: WorkflowRunOptions["resultViewer"];
}

export function codeReviewReport(workflowName: string, result: unknown): ReviewReport | undefined {
  return workflowName === "code-review" && isReviewReport(result) ? result : undefined;
}

export interface ReviewResultsViewerContext {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
}

export function decideReviewResultsPresentation(input: ReviewResultsDecisionInput): ReviewResultsPresentationDecision {
  if (input.workflowName !== "code-review") return { kind: "send", reason: "not-code-review" };
  const report = codeReviewReport(input.workflowName, input.result);
  if (!report) return { kind: "send", reason: "not-advisory" };
  if (report.findings.length === 0) return { kind: "send", reason: "no-findings" };
  if (input.resultViewer === "skip") return { kind: "send", reason: "disabled" };
  if (input.mode !== "tui" || !input.hasUI) return { kind: "send", reason: "not-tui" };

  if (input.resultViewer !== "open") return { kind: "send", reason: "not-requested" };

  return { kind: "open", issues: toReviewIssues(input.workflowName, report) };
}

export async function showReviewResultsViewer(
  ctx: ReviewResultsViewerContext,
  issues: readonly ReviewIssue[],
): Promise<ReviewIssueSelection> {
  return await ctx.ui.custom<ReviewIssueSelection>(
    (tui, theme, _keybindings, done) => new ReviewResultsViewer(issues, "code-review", tui, theme, done),
    WORKFLOW_VIEWER_OVERLAY_OPTIONS,
  );
}
