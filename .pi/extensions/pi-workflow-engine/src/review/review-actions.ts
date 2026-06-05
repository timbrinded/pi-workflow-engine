import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ReviewContext, ReviewIssue, ReviewIssueSelection } from "./review-issues.ts";
import { buildFixHandoffPrompt } from "./review-handoff.ts";

export type ReviewActionPi = Pick<ExtensionAPI, "sendUserMessage">;
export interface ReviewActionContext {
  readonly ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

export async function handleReviewViewerAction(
  pi: ReviewActionPi,
  ctx: ReviewActionContext,
  action: ReviewIssueSelection | undefined,
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
): Promise<void> {
  if (!action || action.action === "close") return;
  const selected = selectedIssues(issues, action.issueIds);
  if (action.action === "fix") {
    if (selected.length === 0) {
      ctx.ui.notify("No selected findings to fix", "warning");
      return;
    }
    pi.sendUserMessage(buildFixHandoffPrompt(selected, context), { deliverAs: "followUp" });
    ctx.ui.notify(`Queued fix request for ${selected.length} selected finding(s)`, "info");
  }
}

function selectedIssues(issues: readonly ReviewIssue[], issueIds: readonly string[]): ReviewIssue[] {
  const selected = new Set(issueIds);
  return issues.filter((issue) => selected.has(issue.id));
}
