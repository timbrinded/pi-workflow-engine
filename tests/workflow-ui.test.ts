import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentDetailParts, formatDuration, truncateDisplay } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-format.ts";
import { formatCount } from "../.pi/extensions/pi-workflow-engine/src/text.ts";
import {
  centerWorkflowViewerViewport,
  fitWorkflowViewerRow,
} from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-viewer-layout.ts";
import { isAdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";

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
