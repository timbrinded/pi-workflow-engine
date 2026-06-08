import assert from "node:assert/strict";
import { test } from "bun:test";
import { ReviewResultsViewer } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-viewer.ts";
import { toReviewIssues, type ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createReviewReportFixture, createTestTheme } from "./fixtures/theme.ts";

test("viewer toggles selections and returns fix action", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());
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

test("viewer digit keys jump to findings and show expanded formatted details", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());
  const viewer = createViewer(issues).viewer;

  viewer.handleInput("2");
  const rendered = viewer.render(140).join("\n");

  assert.match(rendered, /R002.*The cleanup path duplicates parser setup/);
  assert.match(rendered, /Metadata:.*cleanup.*severity medium.*confidence medium/);
  assert.match(rendered, /Location:.*src\/parser\.ts:42/);
  assert.match(rendered, /Impact:.*Future parser changes/);
  assert.match(rendered, /1-9 jump/);
  assert.match(rendered, /enter expand\/collapse/);
});

test("viewer keyboard paths cover select all close fix and comment outcomes", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());

  const closeViewer = createViewer(issues);
  closeViewer.viewer.handleInput(" ");
  closeViewer.viewer.handleInput("q");
  assert.deepEqual(closeViewer.result, { action: "close", issueIds: ["R001"] });

  const commentViewer = createViewer(issues);
  commentViewer.viewer.handleInput("a");
  commentViewer.viewer.handleInput("c");
  assert.deepEqual(commentViewer.result, { action: "comment", issueIds: ["R001", "R002", "R003"] });

  const fixViewer = createViewer(issues);
  fixViewer.viewer.handleInput("a");
  fixViewer.viewer.handleInput("a");
  fixViewer.viewer.handleInput("f");
  assert.equal(fixViewer.result, undefined);
  assert.match(fixViewer.viewer.render(90).join("\n"), /Select at least one finding/);
});

function createViewer(issues: ReturnType<typeof toReviewIssues>): { readonly viewer: ReviewResultsViewer; readonly result: ReviewIssueSelection | undefined } {
  let result: ReviewIssueSelection | undefined;
  return {
    viewer: new ReviewResultsViewer(issues, "code-review", createTestTheme(), () => {}, (value) => {
      result = value;
    }),
    get result() {
      return result;
    },
  };
}
