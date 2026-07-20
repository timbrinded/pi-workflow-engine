import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_LANE_ITEM_LIMIT, ProgressTracker } from "../.pi/extensions/pi-workflow-engine/src/progress.ts";
import { createWorkflowUsageRecorder, formatWorkflowUsageLine } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { createTestTheme } from "./fixtures/theme.ts";

function headlessContext(): ExtensionContext {
  return { hasUI: false } as unknown as ExtensionContext;
}

test("ProgressTracker tracks rows by id and keeps status counts correct", () => {
  const tracker = new ProgressTracker(headlessContext(), "progress-test", "progress-test-run");
  const ids = Array.from({ length: 1_000 }, (_value, index) => tracker.agentQueued("Bulk", `agent:${index}`));

  assert.deepEqual(tracker.statusCounts(), { queued: 1_000, running: 0, done: 0, failed: 0, total: 1_000 });

  tracker.agentStart("Bulk", "agent:999", ids[999]);
  tracker.agentDone("agent:999", ids[999]);
  tracker.agentStart("Bulk", "agent:998", ids[998]);
  tracker.agentFailed("agent:998", new Error("boom"), ids[998]);

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
  tracker.agentStart("Copy", "agent", id);
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

test("ProgressTracker publishes the shared usage line in compact status", () => {
  const statuses: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      theme: createTestTheme(),
      setStatus(_key: string, value: string | undefined) {
        if (value !== undefined) statuses.push(value);
      },
      setWidget() {},
    },
  } as unknown as ExtensionContext;
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "finder",
    messages: [
      {
        role: "assistant",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 0,
          cost: { total: 0.01 },
        },
      },
    ],
  });
  const usage = recorder.snapshot();
  const usageLine = formatWorkflowUsageLine(usage);
  const tracker = new ProgressTracker(ctx, "status-test", "status-test-run");

  try {
    tracker.updateUsage(usage);
    assert.equal(tracker.snapshot().usage, usage);
    assert.ok(usageLine);
    assert.ok(statuses.at(-1)?.includes(usageLine));
  } finally {
    tracker.done();
  }
});

test("concurrent progress trackers use string widgets and clear their run-scoped surfaces in every UI mode", () => {
  for (const mode of ["tui", "rpc"] as const) {
    const statuses = new Map<string, string>();
    const widgets = new Map<string, string[]>();
    const ctx = {
      hasUI: true,
      mode,
      ui: {
        theme: createTestTheme(),
        setStatus(key: string, value: string | undefined) {
          if (value === undefined) statuses.delete(key);
          else statuses.set(key, value);
        },
        setWidget(key: string, value: string[] | undefined) {
          if (value === undefined) widgets.delete(key);
          else {
            assert.ok(Array.isArray(value), `${mode} widgets must use Pi's string[] surface`);
            widgets.set(key, value);
          }
        },
      },
    } as unknown as ExtensionContext;
    const first = new ProgressTracker(ctx, "first", "run-first");
    const second = new ProgressTracker(ctx, "second", "run-second");

    first.phase("Find");
    second.phase("Verify");
    assert.deepEqual([...statuses.keys()].sort(), ["workflow:run-first", "workflow:run-second"]);
    assert.deepEqual([...widgets.keys()].sort(), ["workflow:run-first", "workflow:run-second"]);

    first.done();
    assert.deepEqual([...statuses.keys()], ["workflow:run-second"]);
    assert.deepEqual([...widgets.keys()], ["workflow:run-second"]);
    second.done();
    assert.equal(statuses.size, 0);
    assert.equal(widgets.size, 0);
  }
});

test("ProgressTracker refreshes native widget lines for elapsed time and stops refreshing when done", () => {
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
  const widgets: string[][] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme: createTestTheme(),
      setStatus() {},
      setWidget(_key: string, value: string[] | undefined) {
        if (value !== undefined) widgets.push(value);
      },
    },
  } as unknown as ExtensionContext;
  const tracker = new ProgressTracker(ctx, "timer-test", "timer-test-run");

  try {
    tracker.phase("Long-running");
    assert.ok(tick);
    assert.match(widgets.at(-1)?.[0] ?? "", /0s/);

    now += 1_000;
    tick();
    assert.match(widgets.at(-1)?.[0] ?? "", /1s/);

    tracker.done();
    assert.equal(intervalCleared, true);
  } finally {
    tracker.done();
    Date.now = originalDateNow;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
