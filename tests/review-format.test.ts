import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { renderIssuesTable } from "../.pi/extensions/pi-workflow-engine/src/review/review-format.ts";
import { formatIssueLocation, isCommentableIssue, toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createTestTheme } from "./fixtures/theme.ts";

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

test("renders compact advisory findings table", () => {
  const report = createReport();
  report.findings[0]!.summary = "A very long review summary that should be truncated instead of overflowing the fixed table width.";
  const table = renderIssuesTable(toReviewIssues("code-review", report), createTestTheme(), { maxRows: 1 });

  assert.match(table, /ID/);
  assert.match(table, /Sev/);
  assert.match(table, /Conf/);
  assert.match(table, /Cat/);
  assert.match(table, /Location/);
  assert.match(table, /Summary/);
  assert.match(table, /R001/);
  assert.match(table, /high/);
  assert.match(table, /src\/app\.ts:10 \(retry\)/);
  assert.match(table, /… 1 more finding\(s\)/);
  assert.doesNotMatch(table, /overflowing the fixed table width\./);
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
