import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import {
  createWorkflowRunRecord,
  transitionWorkflowRun,
  type WorkflowRunRecord,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import {
  WorkflowUsageLimitScheduler,
  type WorkflowUsageLimitSchedulerClock,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-usage-limit-scheduler.ts";

class FakeClock implements WorkflowUsageLimitSchedulerClock {
  readonly delays: number[] = [];
  private nextId = 0;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  constructor(private current: number) {}

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.delays.push(delayMs);
    this.timers.set(id, { due: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.timers.delete(handle);
  }

  advance(delayMs: number): void {
    this.current += delayMs;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function context(): ExtensionContext {
  return {
    cwd: "/project",
    sessionManager: { getSessionId: () => "scheduler-session" },
  } as unknown as ExtensionContext;
}

function progress(runId: string): WorkflowProgressSnapshot {
  return {
    runId,
    title: "scheduled",
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  };
}

function pausedRecord(
  runId: string,
  input: { readonly now: number; readonly attempt?: number; readonly maxAttempts?: number; readonly autoResume?: boolean },
): WorkflowRunRecord {
  const mod: LoadedWorkflow = {
    meta: { name: "scheduled", description: "scheduled" },
    default: async () => undefined,
    source: { kind: "fingerprint", fingerprint: "scheduled-source" },
  };
  const queued = createWorkflowRunRecord({
    runId,
    workflow: mod,
    options: resolveWorkflowRunOptions({
      background: { sessionId: "scheduler-session", requestedAt: 1 },
      autoResumeOnUsageLimit: true,
    }, {}),
    progress: progress(runId),
  });
  const running = transitionWorkflowRun(queued, { state: "running", progress: progress(runId), at: 2 });
  const attempt = input.attempt ?? 1;
  const maxAttempts = input.maxAttempts ?? 3;
  return transitionWorkflowRun(running, {
    state: "paused",
    progress: progress(runId),
    message: "provider usage limit",
    pause: {
      kind: "provider_usage_limit",
      reason: "provider_usage_limit",
      providerMessage: "rate limit",
      attempt,
      nextEligibleAt: input.now + 60_000,
      autoResume: input.autoResume ?? attempt < maxAttempts,
      maxAttempts,
    },
    at: 3,
  });
}

test("usage-limit scheduler re-arms only the remaining delay after process restart", () => {
  const record = pausedRecord("restart-delay", { now: 10_000 });
  const firstClock = new FakeClock(10_000);
  const first = new WorkflowUsageLimitScheduler(async () => {}, firstClock);
  assert.equal(first.arm(context(), record), true);
  assert.deepEqual(firstClock.delays, [60_000]);

  const restartedClock = new FakeClock(40_000);
  const restarted = new WorkflowUsageLimitScheduler(async () => {}, restartedClock);
  assert.equal(restarted.arm(context(), record), true);
  assert.deepEqual(restartedClock.delays, [30_000]);
});

test("usage-limit scheduler fires once and cancellation prevents a stale resume", async () => {
  const clock = new FakeClock(1_000);
  const resumed: Array<{ readonly runId: string; readonly attempt: number }> = [];
  const scheduler = new WorkflowUsageLimitScheduler(async (_ctx, runId, attempt) => {
    resumed.push({ runId, attempt });
  }, clock);
  const record = pausedRecord("scheduled-once", { now: 1_000 });

  assert.equal(scheduler.arm(context(), record), true);
  assert.equal(scheduler.arm(context(), record), false);
  clock.advance(60_000);
  await Promise.resolve();
  assert.deepEqual(resumed, [{ runId: "scheduled-once", attempt: 1 }]);
  assert.equal(scheduler.has("scheduled-once"), false);

  const cancelled = pausedRecord("scheduled-cancel", { now: 61_000 });
  assert.equal(scheduler.arm(context(), cancelled), true);
  assert.equal(scheduler.cancel("scheduled-cancel"), true);
  clock.advance(60_000);
  await Promise.resolve();
  assert.equal(resumed.length, 1);
});

test("usage-limit scheduler never arms exhausted or non-opted-in pauses", () => {
  const clock = new FakeClock(0);
  const scheduler = new WorkflowUsageLimitScheduler(async () => {}, clock);
  assert.equal(scheduler.arm(context(), pausedRecord("exhausted", { now: 0, attempt: 3, maxAttempts: 3 })), false);
  assert.equal(scheduler.arm(context(), pausedRecord("disabled", { now: 0, autoResume: false })), false);
  assert.deepEqual(clock.delays, []);
});

test("session shutdown cancels timers and blocks late settlement re-arming", () => {
  const clock = new FakeClock(0);
  const scheduler = new WorkflowUsageLimitScheduler(async () => {}, clock);
  const ctx = context();
  const record = pausedRecord("shutdown", { now: 0 });
  assert.equal(scheduler.arm(ctx, record), true);
  scheduler.cancelSession(ctx);
  assert.equal(scheduler.has(record.runId), false);
  assert.equal(scheduler.arm(ctx, record), false);
  scheduler.activateSession(ctx);
  assert.equal(scheduler.arm(ctx, record), true);
});
