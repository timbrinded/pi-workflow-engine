import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { DEFAULT_LANE_ITEM_LIMIT, ProgressTracker } from "../.pi/extensions/pi-workflow-engine/src/progress.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

function headlessContext(): ExtensionContext {
  return { hasUI: false } as unknown as ExtensionContext;
}

type WidgetFactory = (tui: { requestRender(): void }, theme: Theme) => Component;

/** A UI context that records statuses and widgets the way pi's TUI or RPC mode receives them. */
function uiContext(mode: "tui" | "rpc") {
  const statuses = new Map<string, string>();
  const widgets = new Map<string, string[] | WidgetFactory>();
  const registrations = new Map<string, number>();
  let renders = 0;
  const tui = { requestRender: () => void renders++ };
  const ctx = {
    hasUI: true,
    mode,
    ui: {
      theme: createTestTheme(),
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget(key: string, value: string[] | WidgetFactory | undefined) {
        if (value === undefined) {
          widgets.delete(key);
          return;
        }
        widgets.set(key, value);
        registrations.set(key, (registrations.get(key) ?? 0) + 1);
      },
    },
  } as unknown as ExtensionContext;
  const mount = (key: string): Component => {
    const widget = widgets.get(key);
    if (typeof widget !== "function") throw new Error(`expected a widget component factory for ${key}`);
    return widget(tui, createTestTheme());
  };
  return { ctx, statuses, widgets, registrations, mount, renders: () => renders };
}

test("ProgressTracker tracks rows by id and keeps status counts correct", () => {
  const tracker = new ProgressTracker(headlessContext(), "progress-test", "progress-test-run");
  const ids = Array.from({ length: 1_000 }, (_value, index) => tracker.agentQueued("Bulk", `agent:${index}`));

  assert.deepEqual(tracker.statusCounts(), { queued: 1_000, running: 0, done: 0, failed: 0, total: 1_000 });

  tracker.agentStart(ids[999]);
  tracker.agentDone(ids[999]);
  tracker.agentStart(ids[998]);
  tracker.agentFailed(ids[998], new Error("boom"));

  assert.deepEqual(tracker.statusCounts(), { queued: 998, running: 0, done: 1, failed: 1, total: 1_000 });
  const lastRows = tracker.snapshot().phases.flatMap((phase) => phase.agents).slice(-2);
  assert.equal(lastRows[0]?.status, "failed");
  assert.equal(lastRows[1]?.status, "done");
});

test("ProgressTracker caps lane items and reports overflow", () => {
  const previous = process.env.PI_WORKFLOW_LANE_ITEM_LIMIT;
  process.env.PI_WORKFLOW_LANE_ITEM_LIMIT = "3";
  try {
    const tracker = new ProgressTracker(headlessContext(), "lane-test", "lane-test-run");
    for (let i = 0; i < 5; i++) {
      tracker.event({ type: "lane_item", lane: "Findings", title: `Finding ${i}`, status: "pending" });
    }

    const snapshot = tracker.snapshot();
    assert.equal(snapshot.lanes[0]?.[1].length, 3);
    assert.deepEqual(snapshot.lanes[0]?.[1].map((item) => item.title), ["Finding 2", "Finding 3", "Finding 4"]);
    assert.deepEqual(snapshot.laneOverflow, [["Findings", 2]]);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKFLOW_LANE_ITEM_LIMIT;
    else process.env.PI_WORKFLOW_LANE_ITEM_LIMIT = previous;
  }
});

test("ProgressTracker snapshots copy retained state", () => {
  const tracker = new ProgressTracker(headlessContext(), "copy-test", "copy-test-run");
  const id = tracker.agentQueued("Copy", "agent");
  tracker.agentStart(id);
  tracker.event({ type: "lane_item", lane: "Findings", title: "Finding", status: "success", details: "evidence" });

  const first = tracker.snapshot();
  const second = tracker.snapshot();

  const firstAgent = first.phases.flatMap((phase) => phase.agents)[0];
  const secondAgent = second.phases.flatMap((phase) => phase.agents)[0];
  assert.notEqual(first.phases[0], second.phases[0]);
  assert.notEqual(firstAgent, secondAgent);
  assert.notEqual(first.lanes[0]?.[1][0], second.lanes[0]?.[1][0]);
  assert.equal(DEFAULT_LANE_ITEM_LIMIT, 200);
});

test("ProgressTracker status names the phase, progress and elapsed time and leaves usage to the widget", () => {
  const { ctx, statuses } = uiContext("rpc");
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "finder",
    messages: [{ role: "assistant", usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, cost: { total: 0.01 } } }],
  });
  const tracker = new ProgressTracker(ctx, "status-test", "status-test-run");

  try {
    tracker.phase("Find");
    const done = tracker.agentQueued("Find", "find:a");
    tracker.agentStart(done);
    tracker.agentDone(done);
    tracker.agentStart(tracker.agentQueued("Find", "find:b"));
    tracker.updateUsage(recorder.snapshot());

    const status = plain(statuses.get("workflow:status-test-run") ?? "");
    assert.match(status, /^◆ status-test · Find 1\/2 · \d+s$/);
  } finally {
    tracker.done();
  }
});

test("TUI runs mount one width-aware widget that redraws on change; string-only UIs get pre-rendered lines", () => {
  for (const mode of ["tui", "rpc"] as const) {
    const ui = uiContext(mode);
    const first = new ProgressTracker(ui.ctx, "first", "run-first", undefined, { plannedPhases: ["Find", "Verify"] });
    const second = new ProgressTracker(ui.ctx, "second", "run-second");

    first.phase("Find");
    second.phase("Verify");
    const component = mode === "tui" ? ui.mount("workflow:run-first") : undefined;
    const rendersBefore = ui.renders();
    first.agentStart(first.agentQueued("Find", "find:logic-bugs"));

    const lines = component ? component.render(60) : ui.widgets.get("workflow:run-first");
    if (!Array.isArray(lines)) throw new Error(`${mode}: expected rendered widget lines`);
    assert.ok(lines.every((line) => visibleWidth(line) <= (component ? 60 : 100)), `${mode}: ${lines.map(plain).join("\n")}`);
    assert.match(lines.map(plain).join("\n"), /● Find[\s\S]*● logic-bugs[\s\S]*○ Verify/);
    if (mode === "tui") {
      assert.equal(ui.registrations.get("workflow:run-first"), 1, "the component is registered once and redrawn in place");
      assert.ok(ui.renders() > rendersBefore);
    }

    assert.deepEqual([...ui.statuses.keys()].sort(), ["workflow:run-first", "workflow:run-second"]);
    first.done();
    assert.deepEqual([...ui.widgets.keys()], ["workflow:run-second"]);
    assert.deepEqual([...ui.statuses.keys()], ["workflow:run-second"]);
    second.done();
    assert.equal(ui.widgets.size, 0);
    assert.equal(ui.statuses.size, 0);
  }
});

test("ProgressTracker records late agent events after done without reviving its live surfaces", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalsStarted = 0;
  globalThis.setInterval = (() => {
    intervalsStarted++;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = (() => {}) as typeof clearInterval;
  const widgets = new Map<string, string[]>();
  const statuses = new Map<string, string>();
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: createTestTheme(),
      setStatus(key: string, value: string | undefined) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget(key: string, value: string[] | undefined) {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, value);
      },
    },
  } as unknown as ExtensionContext;
  const snapshots: WorkflowProgressSnapshot[] = [];
  const tracker = new ProgressTracker(ctx, "late-test", "late-test-run", (snapshot) => snapshots.push(snapshot));

  try {
    const id = tracker.agentQueued("Find", "straggler");
    tracker.agentStart(id);
    tracker.done();

    tracker.agentFailed(id, new Error("session creation outlived the drain"));
    tracker.log("progress snapshot callback failed: boom");

    assert.equal(widgets.size, 0);
    assert.equal(statuses.size, 0);
    assert.equal(intervalsStarted, 1);
    assert.equal(snapshots.at(-1)?.phases.flatMap((phase) => phase.agents)[0]?.status, "failed");
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("ProgressTracker redraws once a second for elapsed time and stops when done", () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  const originalDateNow = Date.now;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const fakeInterval = 1 as unknown as ReturnType<typeof setInterval>;
  let tick: (() => void) | undefined;
  let intervalCleared = false;
  Date.now = () => now;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return fakeInterval;
  }) as typeof setInterval;
  globalThis.clearInterval = ((interval: ReturnType<typeof setInterval>) => {
    if (interval === fakeInterval) intervalCleared = true;
  }) as typeof clearInterval;
  const ui = uiContext("tui");
  const tracker = new ProgressTracker(ui.ctx, "timer-test", "timer-test-run");

  try {
    tracker.phase("Long-running");
    const component = ui.mount("workflow:timer-test-run");
    assert.ok(tick);
    assert.match(plain(component.render(80)[0] ?? ""), /\b0s\b/);
    assert.match(plain(ui.statuses.get("workflow:timer-test-run") ?? ""), /\b0s$/);

    now += 1_000;
    const rendersBefore = ui.renders();
    tick();
    assert.ok(ui.renders() > rendersBefore);
    assert.match(plain(component.render(80)[0] ?? ""), /\b1s\b/);
    assert.match(plain(ui.statuses.get("workflow:timer-test-run") ?? ""), /\b1s$/);

    tracker.done();
    assert.equal(intervalCleared, true);
  } finally {
    tracker.done();
    Date.now = originalDateNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
