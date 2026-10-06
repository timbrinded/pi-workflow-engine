import type { AdvisoryFinding, AdvisoryReport } from "../advisory-schema.ts";
import { isFiniteNumber } from "../guards.ts";

export type ReviewIssueAction = "fix" | "comment" | "close";

export interface ReviewIssueSelection {
  readonly action: ReviewIssueAction;
  readonly issueIds: readonly string[];
}

export interface ReviewIssue {
  readonly id: string;
  readonly file?: string;
  readonly line?: number;
  readonly symbol?: string;
  readonly finding: AdvisoryFinding;
}

/** Stable prompt-facing representation shared by review follow-up actions. */
export interface SerializedReviewIssue {
  readonly id: string;
  readonly summary: string;
  readonly category: string;
  readonly severity: string;
  readonly confidence: string;
  readonly location: {
    readonly file?: string;
    readonly line?: number;
    readonly symbol?: string;
    readonly display: string;
  };
  readonly impact: string;
  readonly evidence: readonly string[];
  readonly recommendation: string;
}

export function toReviewIssues(report: Pick<AdvisoryReport, "findings">): ReviewIssue[] {
  return report.findings.map((finding, index) => {
    const location = finding.reviewAnchor ?? finding.locations[0];
    return {
      id: formatIssueId(index),
      file: location?.file,
      line: location?.line,
      symbol: location?.symbol,
      finding,
    };
  });
}

export function formatIssueLocation(issue: ReviewIssue): string {
  if (!issue.file) return "(no location)";
  const line = issue.line != null ? `:${issue.line}` : "";
  const symbol = issue.symbol ? ` (${issue.symbol})` : "";
  return `${issue.file}${line}${symbol}`;
}

export function serializeReviewIssue(issue: ReviewIssue): SerializedReviewIssue {
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

export type CommentableReviewIssue = ReviewIssue & { readonly file: string; readonly line: number };

export function isCommentableIssue(issue: ReviewIssue): issue is CommentableReviewIssue {
  return typeof issue.file === "string" && issue.file.trim().length > 0 && isFiniteNumber(issue.line);
}

function formatIssueId(index: number): string {
  return `R${String(index + 1).padStart(3, "0")}`;
}
