import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFindingDetail, renderFindingRow, sortIssuesForDisplay } from "../.pi/extensions/pi-workflow-engine/src/review/review-format.ts";
import { formatIssueLocation, isCommentableIssue, toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

test("normalizes advisory findings into stable review issues", () => {
  const report = createReport();
  const issues = toReviewIssues(report);

  assert.deepEqual(issues.map((issue) => issue.id), ["R001", "R002"]);
  assert.equal(issues[0]?.file, "src/app.ts");
  assert.equal(issues[0]?.line, 10);
  assert.equal(issues[0]?.symbol, "retry");
  assert.equal(formatIssueLocation(issues[0]!), "src/app.ts:10 (retry)");
  assert.equal(isCommentableIssue(issues[0]!), true);

  assert.equal(formatIssueLocation(issues[1]!), "README.md");
  assert.equal(isCommentableIssue(issues[1]!), false);
  assert.equal(issues[0]?.finding, report.findings[0]);
});

test("finding rows align to the requested width and sort most severe first", () => {
  const theme = createTestTheme();
  const report = createReport();
  report.findings.reverse();
  report.findings[0]!.summary = "A very long review summary that would overflow any reasonable terminal width if it were not truncated.";
  const issues = sortIssuesForDisplay(toReviewIssues(report));

  assert.deepEqual(issues.map((issue) => issue.finding.severity), ["high", "low"]);
  for (const width of [40, 80, 120]) {
    for (const issue of issues) assert.equal(visibleWidth(renderFindingRow(issue, width, theme)), width);
  }
  const row = plain(renderFindingRow(issues[0]!, 100, theme));
  assert.match(row, /HIGH R002  src\/app\.ts:10/);
});

test("finding detail wraps every section inside the width and lists evidence as bullets", () => {
  const theme = createTestTheme();
  const issue = toReviewIssues(createReport())[0]!;
  const lines = renderFindingDetail(issue, 50, theme);

  assert.ok(lines.every((line) => visibleWidth(line) <= 50), lines.join("\n"));
  const text = plain(lines.join("\n"));
  assert.match(text, /Location {2}src\/app\.ts:10 · retry/);
  assert.match(text, /Evidence {2}• line 10 increments/);
  assert.match(text, /Fix {7}Change the loop boundary/);
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
