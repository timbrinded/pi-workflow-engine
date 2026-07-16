import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunOptions } from "../types.ts";
import { isAdvisoryReport, type AdvisoryWorkflowResult } from "../ui/workflow-result-renderer.ts";
import { toReviewIssues, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { ReviewResultsViewer } from "./review-results-viewer.ts";

export type ReviewResultsPresentationDecision =
  | {
      readonly kind: "send";
      readonly reason: "tool-invocation" | "not-code-review" | "not-advisory" | "no-findings" | "disabled" | "not-tui" | "not-requested";
    }
  | { readonly kind: "open"; readonly report: AdvisoryWorkflowResult; readonly issues: readonly ReviewIssue[]; readonly findingCount: number };

export interface ReviewResultsDecisionInput {
  readonly workflowName: string;
  readonly result: unknown;
  readonly mode?: string;
  readonly hasUI: boolean;
  readonly resultViewer?: WorkflowRunOptions["resultViewer"];
  readonly invocationKind?: "command" | "tool";
}

export function codeReviewReport(workflowName: string, result: unknown): AdvisoryWorkflowResult | undefined {
  return workflowName === "code-review" && isAdvisoryReport(result) ? result : undefined;
}

export interface ReviewResultsViewerContext {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
}

export function extensionContextMode(ctx: ExtensionContext): string | undefined {
  const candidate = ctx.mode;
  return typeof candidate === "string" ? candidate : undefined;
}

export function decideReviewResultsPresentation(input: ReviewResultsDecisionInput): ReviewResultsPresentationDecision {
  if (input.invocationKind === "tool") return { kind: "send", reason: "tool-invocation" };
  if (input.workflowName !== "code-review") return { kind: "send", reason: "not-code-review" };
  const report = codeReviewReport(input.workflowName, input.result);
  if (!report) return { kind: "send", reason: "not-advisory" };
  if (report.findings.length === 0) return { kind: "send", reason: "no-findings" };
  if (input.resultViewer === "skip") return { kind: "send", reason: "disabled" };
  if (input.mode !== "tui" || !input.hasUI) return { kind: "send", reason: "not-tui" };

  if (input.resultViewer !== "open") return { kind: "send", reason: "not-requested" };

  const issues = toReviewIssues(input.workflowName, report);
  return { kind: "open", report, issues, findingCount: issues.length };
}

export async function maybeShowReviewResultsViewer(
  ctx: ReviewResultsViewerContext,
  decision: ReviewResultsPresentationDecision,
): Promise<ReviewIssueSelection | undefined> {
  if (decision.kind !== "open") return undefined;

  return await ctx.ui.custom<ReviewIssueSelection>(
    (tui, theme, _keybindings, done) => new ReviewResultsViewer(decision.issues, "code-review", tui, theme, done),
    { overlay: true, overlayOptions: { anchor: "center", width: "80%", minWidth: 40, maxHeight: "80%", margin: 1 } },
  );
}
