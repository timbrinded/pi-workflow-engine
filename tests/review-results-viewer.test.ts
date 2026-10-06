import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { ReviewResultsViewer } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-viewer.ts";
import { toReviewIssues, type ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { createReviewReportFixture, createTestTheme, plain } from "./fixtures/theme.ts";

const DOWN = "\u001b[B";
const PAGE_DOWN = "\u001b[6~";
const ESCAPE = "\u001b";

test("findings are listed most severe first and the cursor starts on the most severe", () => {
  const report = createReviewReportFixture();
  const [high, medium, low] = report.findings;
  if (!high || !medium || !low) throw new Error("expected three fixture findings");
  const { viewer } = createViewer({ ...report, findings: [low, high, medium] });

  const rows = render(viewer, 120).filter((line) => /R00\d/.test(line));
  assert.deepEqual(rows.map((line) => /(HIGH|MED|LOW)\s+(R00\d)/.exec(line)?.slice(1).join(" ")), ["HIGH R002", "MED R003", "LOW R001"]);
  assert.match(rows[0] ?? "", /^│ › ○ HIGH R002/);
});

test("every line fits the overlay width in split and stacked layouts", () => {
  for (const width of [150, 120, 100, 90, 72, 44]) {
    const { viewer } = createViewer();
    for (const key of ["", " ", DOWN, "a"]) {
      if (key) viewer.handleInput(key);
      const lines = viewer.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) === width), `width ${width} after ${JSON.stringify(key)}`);
      assert.match(plain(lines[0] ?? ""), /^╭─ Review findings · code-review ─/);
      assert.match(plain(lines.at(-1) ?? ""), /^╰─.*─╯$/);
    }
  }
});

test("wide overlays put the detail beside the list and narrow ones stack it below", () => {
  const { viewer } = createViewer();

  const split = render(viewer, 120);
  assert.match(split[1] ?? "", /HIGH R001 .*│ HIGH R001 · bug · confidence high/);

  const stacked = render(viewer, 72);
  const detailHeader = stacked.findIndex((line) => /^│ HIGH R001 · bug · confidence high/.test(line));
  const lastRow = stacked.findLastIndex((line) => /R00\d  /.test(line));
  assert.ok(detailHeader > lastRow, "the detail renders below every finding row");
  assert.ok(stacked.slice(lastRow + 1, detailHeader).some((line) => /^│ ─+ │$/.test(line)), "a rule separates list and detail");
});

test("the overlay is content-sized and keeps one height while the cursor moves", () => {
  for (const width of [120, 72]) {
    const { viewer } = createViewer(undefined, 60);
    const heights = [viewer.render(width).length];
    for (let index = 0; index < 2; index++) {
      viewer.handleInput(DOWN);
      heights.push(viewer.render(width).length);
    }

    assert.equal(new Set(heights).size, 1, `height must not change with the cursor finding at width ${width}`);
    assert.ok((heights[0] ?? 0) < 25, `a three-finding review must not fill a 60-row terminal (got ${heights[0]})`);
  }
});

test("space and enter toggle the cursor finding; a toggles all; the header counts selections", () => {
  const { viewer, result } = createViewer();

  assert.match(render(viewer, 120)[0] ?? "", /3 findings ─╮$/);
  assert.doesNotMatch(render(viewer, 120)[0] ?? "", /selected/, "zero selections stay hidden");

  viewer.handleInput(" ");
  assert.match(render(viewer, 120)[0] ?? "", /3 findings · 1 selected ─╮$/);
  assert.match(render(viewer, 120)[1] ?? "", /^│ › ● HIGH R001/);
  viewer.handleInput("\r");
  assert.doesNotMatch(render(viewer, 120)[0] ?? "", /selected/);

  viewer.handleInput("a");
  assert.match(render(viewer, 120)[0] ?? "", /3 selected/);
  viewer.handleInput("a");
  assert.doesNotMatch(render(viewer, 120)[0] ?? "", /selected/);

  viewer.handleInput(DOWN);
  viewer.handleInput(" ");
  viewer.handleInput("q");
  assert.deepEqual(result(), { action: "close", issueIds: ["R002"] });
});

test("selections return in report order whatever the display order", () => {
  const report = createReviewReportFixture();
  const [high, medium, low] = report.findings;
  if (!high || !medium || !low) throw new Error("expected three fixture findings");
  const { viewer, result } = createViewer({ ...report, findings: [low, high, medium] });

  viewer.handleInput("a");
  viewer.handleInput("f");

  assert.deepEqual(result(), { action: "fix", issueIds: ["R001", "R002", "R003"] });
});

test("patch preview and PR comment are gated on a usable selection, with the warning in the footer", () => {
  const nothingSelected = createViewer();
  nothingSelected.viewer.handleInput("f");
  assert.equal(nothingSelected.result(), undefined);
  const warned = render(nothingSelected.viewer, 120).at(-1) ?? "";
  assert.match(warned, /^╰─ ⚠ Select findings first/);
  assert.doesNotMatch(warned, /q close/, "the warning replaces the hint line");
  nothingSelected.viewer.handleInput(DOWN);
  assert.match(render(nothingSelected.viewer, 120).at(-1) ?? "", /↑↓ move · space select · a all · f patch preview · c PR comment · q close/);

  // README.md has no line, so the low finding cannot carry an inline PR comment.
  const uncommentable = createViewer();
  uncommentable.viewer.handleInput("G");
  uncommentable.viewer.handleInput(" ");
  uncommentable.viewer.handleInput("c");
  assert.equal(uncommentable.result(), undefined);
  assert.match(render(uncommentable.viewer, 120).at(-1) ?? "", /None of the selected findings has a file and line/);
  uncommentable.viewer.handleInput("f");
  assert.deepEqual(uncommentable.result(), { action: "fix", issueIds: ["R003"] });

  const commentable = createViewer();
  commentable.viewer.handleInput(" ");
  commentable.viewer.handleInput("c");
  assert.deepEqual(commentable.result(), { action: "comment", issueIds: ["R001"] });
});

test("escape closes with the current selection", () => {
  const { viewer, result } = createViewer();
  viewer.handleInput(" ");
  viewer.handleInput(ESCAPE);
  assert.deepEqual(result(), { action: "close", issueIds: ["R001"] });
});

test("narrow footers shorten their hints instead of truncating them", () => {
  const { viewer } = createViewer();
  const footer = render(viewer, 72).at(-1) ?? "";
  assert.match(footer, /f patch · c comment · q close ─+╯$/);
  assert.doesNotMatch(footer, /…/);
});

test("long reviews scroll the list and the detail, with hints only when content is clipped", () => {
  const report = createReviewReportFixture();
  const template = report.findings[0];
  if (!template) throw new Error("expected review fixture finding");
  const findings = [...new Array<number>(20).keys()].map((index) => ({
    ...template,
    summary: `Finding ${index + 1} ${"with enough detail to wrap ".repeat(30)}`,
  }));
  const { viewer } = createViewer({ ...report, findings }, 24);

  const initial = render(viewer, 120);
  assert.ok(initial.some((line) => /↓ \d+ more/.test(line)), "clipped list and detail show a scroll hint");
  assert.match(initial.at(-1) ?? "", /pgup\/pgdn scroll/);

  for (let index = 0; index < 17; index++) viewer.handleInput(DOWN);
  const scrolled = render(viewer, 120);
  assert.ok(scrolled.some((line) => /^│ › ○ HIGH R018/.test(line)), "the cursor row stays visible");
  assert.ok(scrolled.some((line) => /↑ \d+ more/.test(line)));
  assert.ok(scrolled.length <= 24);

  viewer.handleInput(PAGE_DOWN);
  assert.ok(render(viewer, 120).some((line) => /│ ↑ \d+ more/.test(line)), "page down scrolls the detail pane");

  const short = createViewer();
  assert.ok(!render(short.viewer, 120).some((line) => /more/.test(line)), "unclipped content has no scroll hints");
  assert.doesNotMatch(render(short.viewer, 120).at(-1) ?? "", /pgup/);
});

function render(viewer: ReviewResultsViewer, width: number): string[] {
  return viewer.render(width).map(plain);
}

function createViewer(
  report: AdvisoryReport = createReviewReportFixture(),
  rows = 40,
): { readonly viewer: ReviewResultsViewer; readonly result: () => ReviewIssueSelection | undefined } {
  let result: ReviewIssueSelection | undefined;
  const tui = { requestRender() {}, terminal: { rows, columns: 160 } } as Pick<TUI, "requestRender" | "terminal">;
  const viewer = new ReviewResultsViewer(toReviewIssues(report), tui, createTestTheme(), (value) => {
    result = value;
  });
  return { viewer, result: () => result };
}
