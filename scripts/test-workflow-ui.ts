// No-LLM workflow UI tests. Run: `bun scripts/test-workflow-ui.ts`
import assert from "node:assert/strict";
import { Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { agentDetailParts, formatCount, formatDuration, truncateDisplay } from "../src/ui/workflow-format.ts";
import { isAdvisoryReport, renderWorkflowResultText } from "../src/ui/workflow-result-renderer.ts";

type ThemeBg = Parameters<Theme["bg"]>[0];

const fgKeys: ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

const bgKeys: ThemeBg[] = ["selectedBg", "userMessageBg", "customMessageBg", "toolPendingBg", "toolSuccessBg", "toolErrorBg"];

const theme = new Theme(
  Object.fromEntries(fgKeys.map((key) => [key, ""])) as Record<ThemeColor, string | number>,
  Object.fromEntries(bgKeys.map((key) => [key, ""])) as Record<ThemeBg, string | number>,
  "truecolor",
);

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

assert.equal(isAdvisoryReport(validReport), true);
assert.equal(isAdvisoryReport({ summary: "bad", findings: [{ file: 123, summary: "x" }], nextSteps: [] }), false);
assert.equal(isAdvisoryReport({ summary: "generic workflow", value: 42 }), false);

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

console.log("workflow UI tests passed");
