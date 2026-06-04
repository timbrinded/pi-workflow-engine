import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTestTheme } from "./fixtures/theme.ts";
import { agentDetailParts, formatCount, formatDuration, truncateDisplay } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-format.ts";
import { isAdvisoryReport, renderWorkflowResultText } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-result-renderer.ts";

test("workflow formatting helpers format durations, counts, agents, and truncation", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_600_000), "1h");

  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1_200), "1.2k");
  assert.equal(formatCount(1_200_000), "1.2m");

  const queuedAgent = { id: 1, label: "scope", status: "queued" as const, toolUses: 0 };
  assert.deepEqual(agentDetailParts(queuedAgent), ["queued"]);
  assert.deepEqual(agentDetailParts(queuedAgent, { includeQueuedStatus: false }), []);
  assert.deepEqual(agentDetailParts({ id: 2, label: "find", status: "running" as const, startedAt: 0, toolUses: 0 }, 1_500), ["1s"]);

  const ascii = truncateDisplay("abcdef", 4);
  assert.ok(visibleWidth(ascii) <= 4);
  assert.notEqual(ascii, "abcdef");

  const wide = truncateDisplay("漢字かな", 4);
  assert.ok(visibleWidth(wide) <= 4);
});

test("advisory reports are structurally recognized", () => {
  assert.equal(isAdvisoryReport(validReport), true);
  assert.equal(isAdvisoryReport({ summary: "bad", findings: [{ file: 123, summary: "x" }], nextSteps: [] }), false);
  assert.equal(isAdvisoryReport({ summary: "generic workflow", value: 42 }), false);
});

test("workflow result text renders advisory reports collapsed and expanded", () => {
  const theme = createTestTheme();

  const collapsed = renderWorkflowResultText("refactor-scout", validReport, false, theme);
  assert.match(collapsed, /Workflow: refactor-scout/);
  assert.match(collapsed, /Review complete/);
  assert.match(collapsed, /files 2/);
  assert.match(collapsed, /\[bug\]/);
  assert.match(collapsed, /\[high\]/);
  assert.match(collapsed, /\[high confidence\]/);
  assert.match(collapsed, /src\/app\.ts:10 \(retry\)/);

  const expanded = renderWorkflowResultText("refactor-scout", validReport, true, theme);
  assert.match(expanded, /Impact: A final retry is skipped/);
  assert.match(expanded, /Evidence: line 10 increments before checking the limit/);
  assert.match(expanded, /Recommendation: Change the loop boundary/);
  assert.match(expanded, /Next steps:/);
  assert.match(expanded, /Inspect src\/app\.ts retry loop/);
});

const validReport = {
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
  ],
  nextSteps: ["Inspect src/app.ts retry loop", "Add a retry-boundary regression test"],
  stats: { files: 2, candidates: 3, verified: 1, kept: 1 },
};
