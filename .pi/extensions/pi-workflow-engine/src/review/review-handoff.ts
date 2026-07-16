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

export function buildCommentHandoffPrompt(issues: readonly ReviewIssue[], context: ReviewContext | undefined, reason: string): string {
  return `Use the workflow-code-review-actions skill if available.

Mode: post inline GitHub PR comments for selected code-review findings.

Fallback reason: ${reason}

Selected findings JSON:
\`\`\`json
${JSON.stringify(toHandoffPayload(issues, context))}
\`\`\`

Instructions:
- Do not edit files or make code changes.
- Prefer installed GitHub MCP/tools if present; otherwise use the GitHub CLI (gh).
- With gh, resolve the PR using \`gh pr view\` and \`gh repo view\`, then call \`gh api repos/{owner}/{repo}/pulls/{number}/comments\` with \`commit_id\`, \`path\`, \`line\`, and \`side=RIGHT\`.
- Do not post duplicate comments.
- Do not post line-less findings as inline comments.
- Ask the user if the upstream PR cannot be identified.
- Summarize posted, skipped, and failed comments when done.`;
}

function toHandoffPayload(issues: readonly ReviewIssue[], context: ReviewContext | undefined): ReviewHandoffPayload {
  return {
    context,
    issues: issues.map(toHandoffIssue),
  };
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
