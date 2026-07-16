import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "bun:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { ReviewResultsViewer } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-viewer.ts";
import { toReviewIssues, type ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createReviewReportFixture, createTestTheme } from "./fixtures/theme.ts";

test("viewer toggles selections and returns fix action", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());
  let renders = 0;
  let result: ReviewIssueSelection | undefined;
  const viewer = new ReviewResultsViewer(issues, "code-review", createTui(40, () => renders++), createTestTheme(), (value) => {
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
  assert.match(rendered, /enter details/);
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

test("viewer fills a proportional viewport with a complete centred-modal border", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());
  const terminal = { rows: 40, columns: 160 };
  const tui = createTui(terminal);
  const viewer = new ReviewResultsViewer(issues, "code-review", tui, createTestTheme(), () => {});

  const rendered = viewer.render(120);
  const plain = rendered.map(stripVTControlCharacters);

  assert.equal(rendered.length, 32);
  assert.ok(plain[0]?.startsWith("╭"));
  assert.ok(plain[0]?.endsWith("╮"));
  assert.ok(plain.at(-1)?.startsWith("╰"));
  assert.ok(plain.at(-1)?.endsWith("╯"));
  assert.ok(rendered.every((line) => visibleWidth(line) === 120));

  terminal.rows = 20;
  assert.equal(viewer.render(72).length, 16);
  assert.ok(viewer.render(72).every((line) => visibleWidth(line) === 72));
});

test("viewer keeps long finding lists visible and shows list and detail scroll ranges", () => {
  const report = createReviewReportFixture();
  const template = report.findings[0];
  if (!template) throw new Error("expected review fixture finding");
  const manyFindings = Array.from({ length: 20 }, (_value, index) => ({
    ...template,
    summary: `Finding ${index + 1} ${"with enough detail to wrap ".repeat(30)}`,
  }));
  const issues = toReviewIssues("code-review", { ...report, findings: manyFindings });
  const viewer = new ReviewResultsViewer(issues, "code-review", createTui(24), createTestTheme(), () => {});

  for (let index = 0; index < 12; index++) viewer.handleInput("\u001b[B");
  const listScrolled = stripVTControlCharacters(viewer.render(120).join("\n"));
  assert.match(listScrolled, /> \[ \] R013/);
  assert.match(listScrolled, /\d+–\d+\/20 ↑↓/);
  assert.match(listScrolled, /Lines 1–\d+\/\d+ ↓/);

  viewer.handleInput("\u001b[6~");
  const detailScrolled = stripVTControlCharacters(viewer.render(120).join("\n"));
  assert.match(detailScrolled, /Lines \d+–\d+\/\d+ ↑/);
});

test("viewer preserves its border and selected finding in short terminal viewports", () => {
  const issues = toReviewIssues("code-review", createReviewReportFixture());
  const terminal = { rows: 11, columns: 90 };
  const viewer = new ReviewResultsViewer(issues, "code-review", createTui(terminal), createTestTheme(), () => {});

  for (let rows = 11; rows <= 18; rows++) {
    terminal.rows = rows;
    const rendered = stripVTControlCharacters(viewer.render(72).join("\n"));
    assert.match(rendered, /R001/, `rows=${rows}`);
    assert.match(rendered, /╰─+╯$/, `rows=${rows}`);
    assert.doesNotMatch(rendered, /1–0\//, `rows=${rows}`);
  }

  viewer.handleInput("\u001b[6~");
  const paged = stripVTControlCharacters(viewer.render(72).join("\n"));
  assert.match(paged, /R001/);
  assert.doesNotMatch(paged, /1–0\//);
});

function createViewer(issues: ReturnType<typeof toReviewIssues>): { readonly viewer: ReviewResultsViewer; readonly result: ReviewIssueSelection | undefined } {
  let result: ReviewIssueSelection | undefined;
  return {
    viewer: new ReviewResultsViewer(issues, "code-review", createTui(), createTestTheme(), (value) => {
      result = value;
    }),
    get result() {
      return result;
    },
  };
}

function createTui(
  terminal: { rows: number; columns: number } | number = 40,
  requestRender: () => void = () => {},
): Pick<TUI, "requestRender" | "terminal"> {
  const dimensions = typeof terminal === "number" ? { rows: terminal, columns: 160 } : terminal;
  return { requestRender, terminal: dimensions } as Pick<TUI, "requestRender" | "terminal">;
}
