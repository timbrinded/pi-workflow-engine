import { formatIssueLocation, type ReviewContext, type ReviewIssue } from "./review-issues.ts";

export interface ReviewHandoffPayload {
  readonly context: ReviewContext | undefined;
  readonly issues: readonly ReviewHandoffIssue[];
}

export interface ReviewHandoffIssue {
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

export function buildFixHandoffPrompt(issues: readonly ReviewIssue[], context: ReviewContext | undefined): string {
  const payload: ReviewHandoffPayload = {
    context,
    issues: issues.map(toHandoffIssue),
  };
  return `Use the workflow-code-review-actions skill if available.

Mode: fix selected code-review findings.

Selected findings JSON:
\`\`\`json
${JSON.stringify(payload)}
\`\`\`

Instructions:
- Inspect the selected issue JSON before editing.
- Make minimal edits that address only the selected findings.
- Preserve unrelated user changes and avoid broad refactors.
- Run focused validation if an appropriate local check is available.
- Do not post GitHub PR comments or any upstream review comments.
- Summarize changed files and validation results when done.`;
}

function toHandoffIssue(issue: ReviewIssue): ReviewHandoffIssue {
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
