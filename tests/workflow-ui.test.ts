import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTestTheme } from "./fixtures/theme.ts";
import { agentDetailParts, formatDuration, truncateDisplay } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-format.ts";
import { formatCount } from "../.pi/extensions/pi-workflow-engine/src/text.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import {
  centerWorkflowViewerViewport,
  fitWorkflowViewerRow,
} from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-viewer-layout.ts";
import { isAdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { renderWorkflowWidgetLines } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-widget.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

const usageSnapshot: WorkflowUsageSnapshot = {
  agents: [
    {
      label: "finder",
      phase: "Find",
      provider: "anthropic",
      model: "claude-test",
      assistantMessages: 1,
      usage: {
        input: 12345,
        output: 1800,
        cacheRead: 40000,
        cacheWrite: 5000,
        totalTokens: 59145,
        coverage: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete" },
        cost: { input: 0.01, output: 0.1, cacheRead: 0.003, cacheWrite: 0.01, total: 0.123 },
      },
    },
  ],
  totals: {
    input: 12345,
    output: 1800,
    cacheRead: 40000,
    cacheWrite: 5000,
    totalTokens: 59145,
    coverage: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete" },
    cost: { input: 0.01, output: 0.1, cacheRead: 0.003, cacheWrite: 0.01, total: 0.123 },
  },
  assistantMessages: 1,
};

test("workflow formatting helpers format durations, counts, agents, and truncation", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "999ms");
  assert.equal(formatDuration(1_000), "1s");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(3_600_000), "1h");

  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1_200), "1.2k");
  assert.equal(formatCount(1_200_000), "1.2M");

  const queuedAgent = { id: 1, label: "scope", status: "queued" as const, toolUses: 0 };
  assert.deepEqual(agentDetailParts(queuedAgent), ["queued"]);
  assert.deepEqual(agentDetailParts(queuedAgent, { includeQueuedStatus: false }), []);
  assert.deepEqual(agentDetailParts({ id: 2, label: "find", status: "running" as const, startedAt: 0, toolUses: 0 }, { now: 1_500 }), ["1s"]);

  const ascii = truncateDisplay("abcdef", 4);
  assert.ok(visibleWidth(ascii) <= 4);
  assert.notEqual(ascii, "abcdef");

  const wide = truncateDisplay("漢字かな", 4);
  assert.ok(visibleWidth(wide) <= 4);

  const fitted = fitWorkflowViewerRow("\x1b[31mwide 漢字\x1b[0m", 8);
  assert.equal(visibleWidth(fitted), 8);

  const viewport = centerWorkflowViewerViewport([0, 1, 2, 3, 4, 5], 3, 4);
  assert.deepEqual(viewport, { visible: [3, 4, 5], percentage: 100 });
});

test("workflow widget renders the workflow usage summary", () => {
  const now = Date.now();
  const snapshot: WorkflowProgressSnapshot = {
    runId: "usage-surfaces-test",
    title: "usage-surfaces",
    startedAt: now - 1_000,
    currentPhase: "Find",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
    usage: usageSnapshot,
  };
  const expected = "Usage: fresh 12.3k · cache read 40k · cache write 5k · output 1.8k · cost $0.123 · agents 1";
  const theme = createTestTheme();

  assert.ok(renderWorkflowWidgetLines(snapshot, theme).join("\n").includes(expected));
});

test("workflow widget renders bounded rows for large snapshots", () => {
  const theme = createTestTheme();
  const snapshot = {
    runId: "large-snapshot-test",
    title: "large",
    startedAt: Date.now() - 1_000,
    currentPhase: "Fan-out",
    phases: [
      {
        title: "Find",
        agents: Array.from({ length: 1_000 }, (_value, index) => ({
          id: index + 1,
          label: `agent:${index}`,
          status: index % 3 === 0 ? "running" as const : "done" as const,
          startedAt: Date.now() - 500,
          doneAt: index % 3 === 0 ? undefined : Date.now(),
          toolUses: index % 2,
        })),
      },
    ],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: ["latest update"],
  };

  const lines = renderWorkflowWidgetLines(snapshot, theme);
  assert.ok(lines.length <= 10);
  assert.match(lines.join("\n"), /\+\d+ more/);
  assert.match(lines.at(-1) ?? "", /latest update/);
});

test("advisory reports are structurally recognized", () => {
  assert.equal(isAdvisoryReport(validReport), true);
  assert.equal(
    isAdvisoryReport({
      ...validReport,
      reviewContext: {
        workflowName: "code-review",
        target: "",
        diffTarget: { kind: "git", args: ["diff", "--no-ext-diff", "HEAD~1"] },
        files: ["src/app.ts"],
        summary: "Review",
      },
    }),
    true,
  );
  assert.equal(isAdvisoryReport({ summary: "bad", findings: [{ file: 123, summary: "x" }], nextSteps: [] }), false);
  assert.equal(isAdvisoryReport({ summary: "generic workflow", value: 42 }), false);
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
