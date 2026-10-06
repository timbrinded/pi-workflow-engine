import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, PhaseSnapshot, WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import {
  renderBackgroundWorkflowLine,
  renderWorkflowWidget,
  setWorkflowInspectorShortcut,
} from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-widget.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

const theme = createTestTheme();
const NOW = Date.now();

function agent(id: number, label: string, status: AgentRowSnapshot["status"], extra: Partial<AgentRowSnapshot> = {}): AgentRowSnapshot {
  const startedAt = status === "queued" ? undefined : NOW - 3_000;
  const doneAt = status === "done" || status === "failed" ? NOW - 1_000 : undefined;
  return { id, label, status, startedAt, doneAt, toolUses: 0, ...extra };
}

function snapshot(phases: PhaseSnapshot[], overrides: Partial<WorkflowProgressSnapshot> = {}): WorkflowProgressSnapshot {
  return {
    runId: "3cfb22c2-5434-4359-ad9f-67ed0af1dabb",
    title: "code-review",
    startedAt: NOW - 12_000,
    currentPhase: phases.at(-1)?.title ?? "Workflow",
    phases,
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
    ...overrides,
  };
}

const usage: WorkflowUsageSnapshot = {
  agents: [],
  totals: {
    input: 12_345,
    output: 1_800,
    cacheRead: 40_000,
    cacheWrite: 5_000,
    totalTokens: 59_145,
    coverage: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete" },
    cost: { input: 0.01, output: 0.1, cacheRead: 0.003, cacheWrite: 0.01, total: 0.123 },
  },
  assistantMessages: 1,
};

/** Scope done → Find mid-flight with a failure → Verify/Challenge/Synthesize declared but not reached. */
function findPhaseSnapshot(): WorkflowProgressSnapshot {
  return snapshot(
    [
      { title: "Scope", agents: [agent(1, "scope", "done", { toolUses: 2 })] },
      {
        title: "Find",
        agents: [
          agent(2, "find:logic-bugs", "running", { lastTool: "read", toolUses: 1 }),
          agent(3, "find:simplification-and-a-very-long-lens-label", "running", { toolUses: 2 }),
          agent(4, "find:error-paths", "failed", { error: "faux provider: injected failure for error-paths ".repeat(4) }),
          agent(5, "find:edge-cases", "done", { toolUses: 2 }),
          agent(6, "find:conventions", "queued"),
        ],
      },
    ],
    {
      plannedPhases: ["Scope", "Find", "Verify", "Challenge", "Synthesize"],
      usage,
      counters: [
        { key: "files", label: "files", value: 3 },
        { key: "candidates", label: "candidates", value: 7 },
      ],
    },
  );
}

const lineIndex = (lines: readonly string[], pattern: RegExp): number => lines.findIndex((line) => pattern.test(plain(line)));

test("every widget line fits the terminal width within pi's ten-row widget cap", () => {
  for (const width of [140, 90, 60, 30]) {
    const lines = renderWorkflowWidget(findPhaseSnapshot(), width, theme);
    assert.ok(lines.length <= 10, `${width} cols: ${lines.length} rows`);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width} cols: ${JSON.stringify(plain(line))}`);
  }
});

test("phases stay in chronological order and declared phases not yet reached are listed as upcoming", () => {
  const lines = renderWorkflowWidget(findPhaseSnapshot(), 140, theme).map(plain);
  const scope = lineIndex(lines, /✓ Scope\s+1 agent/);
  const find = lineIndex(lines, /● Find\s+2 running · 1 queued · 1 done · 1 failed/);
  const upcoming = lineIndex(lines, /○ Verify · Challenge · Synthesize/);
  assert.ok(scope > 0 && scope < find && find < upcoming, lines.join("\n"));
  // The active phase lists running agents, then failures, then done; the finished phase stays collapsed.
  const order = ["logic-bugs", "simplification", "error-paths", "edge-cases"].map((label) => lineIndex(lines, new RegExp(`^\\s+[●✗✓] ${label}`)));
  assert.deepEqual([...order].sort((a, b) => a - b), order, lines.join("\n"));
  assert.equal(lineIndex(lines, /^\s+✓ scope/), -1, "finished phases collapse to one line");

  const synthesizing = snapshot(
    [
      { title: "Scope", agents: [agent(1, "scope", "done")] },
      { title: "Synthesize", agents: [agent(2, "synthesize", "running")] },
    ],
    { plannedPhases: ["Scope", "Find", "Verify", "Challenge", "Synthesize"] },
  );
  const late = renderWorkflowWidget(synthesizing, 140, theme).map(plain);
  assert.equal(lineIndex(late, /○ /), -1, "phases skipped before the current one are not upcoming");
});

test("an active phase with more agents than fit reports +N more on its own phase line", () => {
  const agents = Array.from({ length: 1_000 }, (_value, index) => agent(index + 1, `agent:${index}`, index % 3 === 0 ? "running" : "done"));
  const lines = renderWorkflowWidget(snapshot([{ title: "Fan-out", agents }]), 120, theme).map(plain);
  assert.ok(lines.length <= 10);
  const shownRows = lines.filter((line) => /^\s{5}[●✓] agent:/.test(line)).length;
  const phaseLine = lines.find((line) => /● Fan-out/.test(line)) ?? "";
  assert.match(phaseLine, new RegExp(`\\+${1_000 - shownRows} more`));
  assert.equal(lines.filter((line) => /more/.test(line)).length, 1, "no separate overflow row");
});

test("a failed agent keeps a row when running agents alone would fill the widget", () => {
  const agents = [
    ...Array.from({ length: 12 }, (_value, index) => agent(index + 1, `find:lens-${index}`, "running")),
    agent(13, "find:error-paths", "failed", { error: "provider rejected the request" }),
  ];
  const text = renderWorkflowWidget(snapshot([{ title: "Find", agents }]), 120, theme).map(plain).join("\n");
  assert.match(text, /✗ error-paths\s+provider rejected the request/);
});

test("zero values are hidden and verdict counters read lower-case once", () => {
  const view = snapshot(
    [
      { title: "Scope", agents: [agent(1, "scope", "done")] },
      { title: "Verify", agents: [agent(2, "verify:cache.ts", "done"), agent(3, "verify:flags.ts", "running")] },
    ],
    {
      counters: [
        { key: "files", label: "files", value: 3 },
        { key: "dropped", label: "dropped", value: 0 },
        { key: "verdict.confirmed", label: "CONFIRMED", value: 2 },
        { key: "verdict.not_substantiated", label: "NOT_SUBSTANTIATED", value: 1 },
        { key: "verdict.refuted", label: "REFUTED", value: 1 },
        { key: "refuted", label: "refuted", value: 1 },
      ],
    },
  );
  const text = renderWorkflowWidget(view, 140, theme).map(plain).join("\n");
  assert.match(text, /3 files · 2 confirmed · 1 not substantiated · 1 refuted/);
  assert.doesNotMatch(text, /\b0 \w|dropped|CONFIRMED|refuted · 1 refuted/);
  assert.doesNotMatch(text, /failed|queued/, "statuses with no agents are not mentioned");
});

test("the footer names the configured inspector shortcut, or the command when none is bound", () => {
  try {
    setWorkflowInspectorShortcut("ctrl+alt+i");
    assert.match(plain(renderWorkflowWidget(findPhaseSnapshot(), 120, theme).at(-1) ?? ""), /ctrl\+alt\+i inspect\s*$/);
  } finally {
    setWorkflowInspectorShortcut(null);
  }
  assert.match(plain(renderWorkflowWidget(findPhaseSnapshot(), 120, theme).at(-1) ?? ""), /\/workflow:inspector inspect\s*$/);
});

test("long workflows fold earlier finished phases into one line so active agents stay visible", () => {
  const finished = Array.from({ length: 8 }, (_value, index) => ({ title: `Stage ${index + 1}`, agents: [agent(index + 1, `stage-${index}`, "done")] }));
  const active = { title: "Final", agents: Array.from({ length: 4 }, (_value, index) => agent(100 + index, `final:${index}`, "running")) };
  const lines = renderWorkflowWidget(snapshot([...finished, active]), 140, theme).map(plain);
  assert.ok(lines.length <= 10);
  assert.match(lines.join("\n"), /✓ Stage 1 · Stage 2 · .*Stage 8\s+8 agents/);
  assert.ok(lines.filter((line) => /^\s{5}● /.test(line)).length >= 3, lines.join("\n"));
});

test("a failure log appears only when no failed agent already accounts for it", () => {
  const retrying = snapshot([{ title: "Find", agents: [agent(1, "find:logic-bugs", "running")] }], {
    logs: ["find:logic-bugs: transient provider failure; retry 1/3 in 500ms"],
  });
  assert.match(renderWorkflowWidget(retrying, 140, theme).map(plain).join("\n"), /⚠ find:logic-bugs: transient provider failure/);

  const failedRow = snapshot([{ title: "Find", agents: [agent(1, "find:logic-bugs", "failed", { error: "boom" })] }], {
    logs: ["find:logic-bugs failed: boom"],
  });
  const text = renderWorkflowWidget(failedRow, 140, theme).map(plain).join("\n");
  assert.equal(text.match(/boom/g)?.length, 1, text);

  const collapsedFailure = snapshot(
    [
      { title: "Find", agents: [agent(1, "find:logic-bugs", "failed", { error: "boom" }), agent(2, "find:edge-cases", "done")] },
      { title: "Verify", agents: [agent(3, "verify:a.ts", "running")] },
    ],
    { logs: ["find:logic-bugs failed: boom"] },
  );
  const collapsed = renderWorkflowWidget(collapsedFailure, 140, theme).map(plain).join("\n");
  assert.match(collapsed, /⚠ Find\s+2 agents · [\d.]+s · 1 failed/);
  assert.doesNotMatch(collapsed, /boom/, "the finished phase already counts the failure");

  const quiet = snapshot([{ title: "Find", agents: [agent(1, "find:logic-bugs", "running")] }], { logs: ["3 changed files"] });
  assert.doesNotMatch(renderWorkflowWidget(quiet, 140, theme).map(plain).join("\n"), /changed files/);
});

test("a background run renders as one fitted line with its short run id and phase progress", () => {
  const view = snapshot([
    { title: "Scope", agents: [agent(1, "scope", "done")] },
    { title: "Find", agents: [agent(2, "find:a", "running"), agent(3, "find:b", "failed", { error: "x" }), agent(4, "find:c", "done")] },
  ]);
  for (const width of [140, 40]) {
    const lines = renderBackgroundWorkflowLine(view, width, theme);
    assert.equal(lines.length, 1);
    assert.ok(visibleWidth(lines[0] ?? "") <= width);
  }
  const line = plain(renderBackgroundWorkflowLine(view, 140, theme)[0] ?? "");
  assert.match(line, /◆ background · code-review 3cfb22c2 · Find 3\/4 · 1 failed · 12s\s+\/workflow:inspector inspect$/);
  assert.doesNotMatch(line, /5434-4359/);
});
