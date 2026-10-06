import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "bun:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { createTestTheme } from "./fixtures/theme.ts";
import type { AgentRowSnapshot, WorkflowLaneItemSnapshot, WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import { WorkflowInspector, type WorkflowInspectorOutcome } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-inspector.ts";
import type { WorkflowUsageTotals } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

const KEY = { tab: "\t", shiftTab: "\x1b[Z", left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", enter: "\r" } as const;
const T0 = 1_700_000_000_000;
const RUN_ID = "3cfb22c2-5434-4359-ad9f-67ed0af1dabb";

function agent(id: number, label: string, status: AgentRowSnapshot["status"], extra: Partial<AgentRowSnapshot> = {}): AgentRowSnapshot {
  const started = status === "queued" ? {} : { startedAt: T0 + id * 100 };
  const done = status === "done" || status === "failed" ? { doneAt: T0 + id * 100 + 600 } : {};
  return { id, label, status, toolUses: 0, ...started, ...done, ...extra };
}

function laneItem(lane: string, title: string, status: WorkflowLaneItemSnapshot["status"], createdAt: number, extra: Partial<WorkflowLaneItemSnapshot> = {}): WorkflowLaneItemSnapshot {
  return { lane, title, subtitle: "src/cache.ts:13 (readEntry)", status, createdAt, ...extra };
}

const usageTotals: WorkflowUsageTotals = {
  input: 12_345,
  output: 1_800,
  cacheRead: 40_000,
  cacheWrite: 5_000,
  totalTokens: 59_145,
  coverage: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete" },
  cost: { input: 0.01, output: 0.1, cacheRead: 0.003, cacheWrite: 0.01, total: 0.123 },
};

/** A finished code-review: one failed finder, one candidate verified, one never verified. */
function completedReview(overrides: Partial<WorkflowProgressSnapshot> = {}): WorkflowProgressSnapshot {
  return {
    runId: RUN_ID,
    title: "code-review",
    startedAt: T0,
    doneAt: T0 + 4_000,
    currentPhase: "Synthesize",
    phases: [
      { title: "Workflow", agents: [] },
      { title: "Scope", agents: [agent(1, "scope", "done")] },
      {
        title: "Find",
        agents: [
          agent(2, "find:logic-bugs", "done", { toolUses: 2, lastTool: "read" }),
          agent(3, "find:error-paths", "failed", { error: "injected failure for error-paths" }),
        ],
      },
      { title: "Verify", agents: [agent(4, "verify:cache.ts", "done")] },
      { title: "Synthesize", agents: [agent(5, "synthesize", "done")] },
    ],
    counters: [
      { key: "files", label: "files", value: 3 },
      { key: "candidates", label: "candidates", value: 2 },
      { key: "dropped", label: "dropped", value: 0 },
      { key: "verdict.confirmed", label: "CONFIRMED", value: 1 },
      { key: "verified", label: "verified", value: 1 },
      { key: "kept", label: "kept", value: 1 },
    ],
    summary: [
      ["files", "src/cache.ts, src/flags.ts, src/retry.ts"],
      ["kept", 1],
    ],
    lanes: [
      [
        "Candidates",
        [
          laneItem("Candidates", "Concurrent callers observe a partially built cache entry", "pending", T0 + 1_000),
          laneItem("Candidates", "The parser silently accepts an empty flag value", "pending", T0 + 1_100, { subtitle: "src/flags.ts:7" }),
        ],
      ],
      [
        "Confirmed",
        [laneItem("Confirmed", "Concurrent callers observe a partially built cache entry", "success", T0 + 2_000, { details: "line 13 publishes before the write" })],
      ],
    ],
    laneOverflow: [],
    logs: [`run id: ${RUN_ID}`, "find:error-paths failed: injected failure for error-paths", "1 verified → 1 kept"],
    usage: {
      agents: [{ label: "find:error-paths", phase: "Find", provider: "anthropic", model: "claude-test", assistantMessages: 1, usage: usageTotals }],
      totals: usageTotals,
      assistantMessages: 1,
    },
    ...overrides,
  };
}

function liveReview(): WorkflowProgressSnapshot {
  const started = Date.now() - 12_000;
  const completed = completedReview();
  return {
    ...completed,
    startedAt: started,
    doneAt: undefined,
    currentPhase: "Verify",
    phases: [
      ...completed.phases.slice(0, 3),
      { title: "Verify", agents: [{ id: 4, label: "verify:cache.ts", status: "running", startedAt: started + 9_000, toolUses: 1, lastTool: "grep" }] },
    ],
  };
}

function createInspector(
  snapshot: () => WorkflowProgressSnapshot,
  options: { rows?: number; outcome?: WorkflowInspectorOutcome | (() => WorkflowInspectorOutcome | undefined) } = {},
) {
  const terminal = { rows: options.rows ?? 45, columns: 140 };
  let closed = false;
  const tui = { requestRender() {}, terminal } as Pick<TUI, "requestRender" | "terminal">;
  const inspector = new WorkflowInspector(snapshot, tui, createTestTheme(), () => (closed = true), options.outcome);
  const text = (width: number) => stripVTControlCharacters(inspector.render(width).join("\n"));
  return { inspector, terminal, text, closed: () => closed };
}

test("every inspector line fits the overlay width, live and completed, on every tab", () => {
  for (const snapshot of [liveReview(), completedReview()]) {
    const { inspector } = createInspector(() => snapshot, { outcome: { text: JSON.stringify({ summary: "x".repeat(300) }, null, 2) } });
    for (const width of [140, 112, 80, 72, 40]) {
      for (let tab = 1; tab <= 5; tab++) {
        inspector.handleInput(String(tab));
        inspector.handleInput(KEY.enter);
        const lines = inspector.render(width);
        const plain = lines.map((line) => stripVTControlCharacters(line));
        assert.ok(lines.every((line) => visibleWidth(line) === width), `width=${width} tab=${tab}`);
        assert.match(plain[0] ?? "", /^╭─ ◆ code-review .*╮$/);
        assert.match(plain.at(-1) ?? "", /^╰.*╯$/);
      }
    }
    inspector.dispose();
  }
});

test("inspector height follows content, stays stable across tabs, and never exceeds the terminal ceiling", () => {
  const small = createInspector(() => completedReview(), { rows: 45 });
  const heights = [1, 2, 3, 4].map((tab) => {
    small.inspector.handleInput(String(tab));
    return small.inspector.render(100).length;
  });
  assert.equal(new Set(heights).size, 1, `tab heights differ: ${heights.join(", ")}`);
  assert.ok((heights[0] ?? 0) < 36, `a short run should not fill 80% of the terminal (got ${heights[0]})`);

  const crowded = completedReview({
    phases: [{ title: "Find", agents: Array.from({ length: 60 }, (_, index) => agent(index + 1, `find:lens-${index + 1}`, "done")) }],
  });
  const large = createInspector(() => crowded, { rows: 30 });
  large.inspector.handleInput("2");
  const lines = large.inspector.render(100);
  assert.ok(lines.length <= 24, `overlay must stay within 80% of 30 rows (got ${lines.length})`);
  assert.match(stripVTControlCharacters(lines.at(-1) ?? ""), /↓ \d+ more ─╯$/);
});

test("tab, shift+tab, arrows and digits move between sections; Result exists only with retained text", () => {
  const { inspector, text } = createInspector(() => completedReview());
  const section = () => {
    const body = text(120);
    if (/✓ Scope +1 agent/.test(body)) return "overview";
    if (/› ✓ scope/.test(body)) return "agents";
    if (/Confirmed 1/.test(body)) return "findings";
    if (/run id: 3cfb22c2/.test(body)) return "logs";
    return "unknown";
  };
  const visited = [KEY.tab, KEY.tab, KEY.tab, KEY.tab, KEY.shiftTab, KEY.left, KEY.right, "3", "5"].map((key) => {
    inspector.handleInput(key);
    return section();
  });
  assert.deepEqual(visited, ["agents", "findings", "logs", "overview", "logs", "findings", "logs", "findings", "findings"]);
  assert.doesNotMatch(text(120), /Result/);

  const retained = createInspector(() => completedReview(), { outcome: { text: '{\n  "summary": "retained result"\n}', state: "completed" } });
  retained.inspector.handleInput("5");
  const result = retained.text(120);
  assert.match(result, /Overview │ Agents 5 │ Findings 2 │ Logs 3 │ Result/);
  assert.match(result, /^│ {3}"summary": "retained result" +│$/m, "result keeps the source indentation");

  retained.inspector.handleInput("q");
  assert.ok(retained.closed());
});

test("enter expands an agent with its full error, model and usage, and collapses it again", () => {
  const { inspector, text } = createInspector(() => completedReview());
  inspector.handleInput("2");
  inspector.handleInput("j");
  inspector.handleInput("j");
  const collapsed = text(120);
  assert.match(collapsed, /› ✗ error-paths .*injected failure for error-paths/);
  assert.doesNotMatch(collapsed, /anthropic\/claude-test/);

  inspector.handleInput(KEY.enter);
  const expanded = text(120);
  assert.match(expanded, /error +injected failure for error-paths/);
  assert.match(expanded, /model +anthropic\/claude-test/);
  assert.match(expanded, /usage +↑57\.3k ↓1\.8k/);

  inspector.handleInput(KEY.enter);
  assert.doesNotMatch(text(120), /model +anthropic\/claude-test/);
});

test("a verified candidate appears once under its verdict and unverified candidates never read as pending once the run is done", () => {
  const done = createInspector(() => completedReview());
  done.inspector.handleInput("3");
  const completed = done.text(120);
  assert.equal(completed.match(/Concurrent callers observe/g)?.length, 1);
  assert.match(completed, /Confirmed 1[\s\S]*Candidates 1 · not verified/, "verdict lanes come before unverified candidates");
  assert.match(completed, /– The parser silently accepts/);
  assert.doesNotMatch(completed, /○/);

  const live = createInspector(() => ({ ...completedReview(), doneAt: undefined }));
  live.inspector.handleInput("3");
  const running = live.text(120);
  assert.match(running, /○ The parser silently accepts/);
  assert.doesNotMatch(running, /not verified/);
  live.inspector.dispose();

  done.inspector.handleInput(KEY.down);
  done.inspector.handleInput(KEY.up);
  done.inspector.handleInput(KEY.enter);
  assert.match(done.text(120), /src\/cache\.ts:13 \(readEntry\)[^\n]*\n[^\n]*line 13 publishes before the write/);
});

test("the header reports live progress, failures and the lifecycle state without raw ids", () => {
  const live = createInspector(() => liveReview());
  const running = live.text(140).split("\n")[0] ?? "";
  assert.match(running, /● running · Verify 3\/4 · 1 failed · 12s · run 3cfb22c2 ─╮$/);
  live.inspector.handleInput("4");
  const logs = live.text(140);
  assert.match(logs, /• run id: 3cfb22c2 /);
  assert.doesNotMatch(logs, /3cfb22c2-5434/, "full run ids never render, logs included");
  live.inspector.dispose();

  const degraded = createInspector(() => completedReview(), { outcome: { state: "completed" } });
  assert.match(degraded.text(140).split("\n")[0] ?? "", /⚠ completed · 1 failed · 4s · run 3cfb22c2 ─╮$/);

  let state: WorkflowInspectorOutcome["state"] = "running";
  const settling = createInspector(() => completedReview(), { outcome: () => ({ state }) });
  assert.match(settling.text(140).split("\n")[0] ?? "", /● running/);
  state = "failed";
  assert.match(settling.text(140).split("\n")[0] ?? "", /✗ failed · 1 failed · 4s/, "the state provider is re-read on every render");

  const narrow = createInspector(() => completedReview(), { outcome: { state: "completed" } });
  const header = narrow.text(44).split("\n")[0] ?? "";
  assert.match(header, /⚠ completed · 1 failed ─╮$/, "low-priority parts drop whole instead of truncating");
});

test("the overview hides zero counters, lower-cases verdicts and does not repeat counted summaries", () => {
  const { text } = createInspector(() => completedReview());
  const overview = text(120);
  assert.match(overview, /✓ Find +2 agents +0\.\ds +1 failed/);
  assert.match(overview, /Funnel +3 files → 2 candidates → 1 verified → 1 kept/);
  assert.match(overview, /Verdicts +1 confirmed/);
  assert.match(overview, /Files +src\/cache\.ts, src\/flags\.ts, src\/retry\.ts/);
  assert.match(overview, /✗ failed +error-paths +injected failure for error-paths/);
  assert.doesNotMatch(overview, /CONFIRMED|dropped|Kept|Workflow +no agents/);
});

test("logs mark failures and keep selection-free scrolling within the overlay", () => {
  const logs = Array.from({ length: 40 }, (_, index) => `step ${index + 1} finished`);
  logs.push("find:error-paths failed: injected failure");
  const { inspector, text } = createInspector(() => completedReview({ logs }), { rows: 20 });
  inspector.handleInput("4");
  assert.match(text(80), /• step 1 finished[\s\S]*↓ \d+ more ─╯$/);
  inspector.handleInput("G");
  const bottom = text(80);
  assert.match(bottom, /✗ find:error-paths failed: injected failure/);
  assert.match(bottom, /↑ \d+ more ─╯$/);
  assert.doesNotMatch(bottom, /↓ \d+ more/);
});

test("the agent cursor stays visible while moving through a list taller than the overlay", () => {
  const crowded = completedReview({
    phases: [{ title: "Find", agents: Array.from({ length: 40 }, (_, index) => agent(index + 1, `find:lens-${index + 1}`, "done")) }],
  });
  const { inspector, text } = createInspector(() => crowded, { rows: 20 });
  inspector.handleInput("2");
  for (let index = 0; index < 25; index++) inspector.handleInput(KEY.down);
  assert.match(text(80), /› ✓ lens-26 /);
  inspector.handleInput("G");
  assert.match(text(80), /› ✓ lens-40 /);
  inspector.handleInput("g");
  assert.match(text(80), /› ✓ lens-1 /);
});
