import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReviewIssue, ReviewIssueSelection } from "./review-issues.ts";
import { ReviewResultsViewer } from "./review-results-viewer.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "../ui/workflow-viewer-layout.ts";

export interface ReviewResultsViewerContext {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
}

export async function showReviewResultsViewer(
  ctx: ReviewResultsViewerContext,
  issues: readonly ReviewIssue[],
): Promise<ReviewIssueSelection> {
  return await ctx.ui.custom<ReviewIssueSelection>(
    (tui, theme, _keybindings, done) => new ReviewResultsViewer(issues, tui, theme, done),
    WORKFLOW_VIEWER_OVERLAY_OPTIONS,
  );
}
