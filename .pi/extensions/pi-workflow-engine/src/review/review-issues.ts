import type { AdvisoryFinding, AdvisoryReport } from "../advisory-schema.ts";

export type ReviewIssueAction = "fix" | "comment" | "close";

export interface ReviewIssueSelection {
  readonly action: ReviewIssueAction;
  readonly issueIds: readonly string[];
}

/** Atomic identity of the exact diff and post-change snapshot that were reviewed. */
export interface ReviewSnapshotIdentity {
  readonly diffFingerprint: string;
  readonly baselineFingerprint: string;
}

export interface ReviewContext {
  readonly workflowName: string;
  readonly target: string;
  readonly diffCommand: string;
  readonly files: readonly string[];
  readonly summary?: string;
  /** Present only when the diff and its reconstructable baseline were captured together. */
  readonly snapshot?: ReviewSnapshotIdentity;
}

export interface ReviewIssue {
  readonly id: string;
  readonly index: number;
  readonly workflowName: string;
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

export interface ReviewReportWithContext extends AdvisoryReport {
  readonly stats?: Record<string, string | number>;
  readonly reviewContext?: ReviewContext;
}

export function toReviewIssues(name: string, report: Pick<AdvisoryReport, "findings">): ReviewIssue[] {
  return report.findings.map((finding, index) => {
    const location = finding.locations[0];
    return {
      id: formatIssueId(index),
      index,
      workflowName: name,
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

export function isCommentableIssue(issue: ReviewIssue): boolean {
  return typeof issue.file === "string" && issue.file.trim().length > 0 && typeof issue.line === "number" && Number.isFinite(issue.line);
}

function formatIssueId(index: number): string {
  return `R${String(index + 1).padStart(3, "0")}`;
}
