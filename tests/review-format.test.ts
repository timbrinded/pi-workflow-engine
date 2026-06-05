import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { formatIssueLocation, isCommentableIssue, toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";

test("normalizes advisory findings into stable review issues", () => {
  const report = createReport();
  const issues = toReviewIssues("code-review", report);

  assert.deepEqual(issues.map((issue) => issue.id), ["R001", "R002"]);
  assert.equal(issues[0]?.workflowName, "code-review");
  assert.equal(issues[0]?.file, "src/app.ts");
  assert.equal(issues[0]?.line, 10);
  assert.equal(issues[0]?.symbol, "retry");
  assert.equal(formatIssueLocation(issues[0]!), "src/app.ts:10 (retry)");
  assert.equal(isCommentableIssue(issues[0]!), true);

  assert.equal(formatIssueLocation(issues[1]!), "README.md");
  assert.equal(isCommentableIssue(issues[1]!), false);
  assert.equal(issues[0]?.finding, report.findings[0]);
});

function createReport(): AdvisoryReport {
  return {
    summary: "Review complete.",
    findings: [
      {
        summary: "Off-by-one in retry loop.",
        category: "bug",
        severity: "high",
        confidence: "high",
        locations: [{ file: "src/app.ts", line: 10, symbol: "retry" }],
        evidence: ["line 10 increments before checking the limit"],
        impact: "A final retry is skipped.",
        recommendation: "Change the loop boundary after adding a regression test.",
      },
      {
        summary: "Documentation omits the new flag.",
        category: "cleanup",
        severity: "low",
        confidence: "medium",
        locations: [{ file: "README.md" }],
        evidence: ["README lists old flags only"],
        impact: "Users may miss the new workflow option.",
        recommendation: "Document the flag in the workflow usage section.",
      },
    ],
    nextSteps: ["Inspect src/app.ts retry loop"],
  };
}
