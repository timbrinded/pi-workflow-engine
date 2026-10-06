import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatCost, frame, overlayHeight, relativeTime, spread, truncatePath } from "../.pi/extensions/pi-workflow-engine/src/ui/kit.ts";
import { createTestTheme } from "./fixtures/theme.ts";

test("truncatePath keeps the file name and as many parent segments as fit", () => {
  assert.equal(truncatePath("src/review/review-format.ts:13", 40), "src/review/review-format.ts:13");
  assert.equal(truncatePath("src/review/review-format.ts:13", 26), "…/review-format.ts:13");
  assert.equal(truncatePath("src/review/review-format.ts:13", 10), "…mat.ts:13");
});

test("frame draws every row at exactly the requested width with title and footer in the borders", () => {
  const theme = createTestTheme();
  const lines = frame(["short", "x".repeat(200)], 60, theme, { title: "Workflow · code-review", right: "✓ done", footer: "q close" });
  assert.ok(lines.every((line) => visibleWidth(line) === 60), lines.map((line) => visibleWidth(line)).join(","));
  assert.match(lines[0] ?? "", /Workflow · code-review.*✓ done/);
  assert.match(lines[lines.length - 1] ?? "", /q close/);
});

test("spread right-aligns the right side and truncates the left first", () => {
  assert.equal(visibleWidth(spread("left side text", "right", 12)), 12);
  assert.match(spread("left", "right", 20), /^left\s+right$/);
});

test("overlayHeight sizes to content between a floor and 80% of the terminal", () => {
  assert.equal(overlayHeight(50, 5), 10);
  assert.equal(overlayHeight(50, 25), 25);
  assert.equal(overlayHeight(50, 200), 40);
  assert.equal(overlayHeight(12, 200), 9);
});

test("formatCost and relativeTime stay short", () => {
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(relativeTime(0, 90_000), "2m ago");
});
