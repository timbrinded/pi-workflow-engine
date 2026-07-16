import { serializeReviewIssue, type ReviewContext, type ReviewIssue } from "./review-issues.ts";

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

function toHandoffPayload(issues: readonly ReviewIssue[], context: ReviewContext | undefined) {
  return {
    context,
    issues: issues.map(serializeReviewIssue),
  };
}
