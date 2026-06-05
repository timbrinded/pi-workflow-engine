import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { ReviewResultsViewer } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-viewer.ts";
import { toReviewIssues, type ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createTestTheme } from "./fixtures/theme.ts";

test("viewer toggles selections and returns fix action", () => {
  const issues = toReviewIssues("code-review", createReport());
  let renders = 0;
  let result: ReviewIssueSelection | undefined;
  const viewer = new ReviewResultsViewer(issues, "code-review", createTestTheme(), () => renders++, (value) => {
    result = value;
  });

  const initial = viewer.render(110).join("\n");
  assert.match(initial, /Review results/);
  assert.match(initial, /R001/);
  assert.match(initial, /Impact/);

  viewer.handleInput(" ");
  viewer.handleInput("f");

  assert.equal(renders, 1);
  assert.deepEqual(result, { action: "fix", issueIds: ["R001"] });
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
