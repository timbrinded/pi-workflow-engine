import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  runAgent as runAgentWithContext,
  type AgentProgress,
  type CreateAgentSession,
  type RunContext,
} from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { WorkflowBudgetExceededError } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { isFatalWorkflowError, WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { WorkflowAgentLimiter } from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import { defaultAgentRetryScheduler } from "../.pi/extensions/pi-workflow-engine/src/agent-retry.ts";
import { hostWorkflowModelProfiles } from "../.pi/extensions/pi-workflow-engine/src/model-profiles.ts";
import { DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS, DEFAULT_WORKFLOW_MAX_AGENTS } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import { NoopPerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { createMemoryBackedJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { WorktreeRegistry } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import type { AgentResumeBaseContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";

const RESUME_BASE_CONTEXT: AgentResumeBaseContext = {
  workflow: { kind: "verified", name: "cancellation-test", sourceFingerprint: "source-a" },
};

function runAgent(
  rc: RunContext,
  prompt: string,
  opts: Parameters<typeof runAgentWithContext>[2] = {},
): Promise<unknown> {
  return runAgentWithContext(rc, prompt, opts, RESUME_BASE_CONTEXT);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProgress(): AgentProgress & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    agentQueued(_phase, label) {
      events.push(`queued:${label}`);
      return events.length;
    },
    agentStart(_phase, label) {
      events.push(`start:${label}`);
    },
    agentTool() {},
    agentDone(label) {
      events.push(`done:${label}`);
    },
    agentFailed(label) {
      events.push(`failed:${label}`);
    },
    log() {},
  };
}

function createRunContext(createSession: CreateAgentSession, signal: AbortSignal, progress: AgentProgress = createProgress(), semaphore = new Semaphore(1)): RunContext {
  return {
    cwd: process.cwd(),
    hostModel: undefined,
    modelRegistry: { find: () => undefined },
    semaphore,
    agentLimiter: new WorkflowAgentLimiter(DEFAULT_WORKFLOW_MAX_AGENTS),
    agentTimeoutMs: DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
    agentRetries: 0,
    retryScheduler: defaultAgentRetryScheduler,
    modelProfiles: hostWorkflowModelProfiles(undefined),
    progress,
    signal,
    perf: new NoopPerfRecorder(),
    usage: createWorkflowUsageRecorder(),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    journal: createMemoryBackedJournal(),
    worktrees: new WorktreeRegistry(process.cwd()),
    createSession,
  };
}

test("Semaphore rejects an aborted queued waiter without leaking slots", async () => {
  const semaphore = new Semaphore(1);
  let releaseFirst: (() => void) | undefined;
  const first = semaphore.run(async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  const controller = new AbortController();
  const queued = semaphore.run(async () => "should not run", { signal: controller.signal });
  controller.abort(new WorkflowAbortError("cancelled"));

  await assert.rejects(queued, /cancelled/);
  releaseFirst?.();
  await first;

  const after = await semaphore.run(async () => "after");
  assert.equal(after, "after");
});

test("isFatalWorkflowError classifies run aborts as fatal", () => {
  const controller = new AbortController();
  controller.abort(new WorkflowAbortError("cancelled"));

  assert.equal(isFatalWorkflowError(new Error("plain"), controller.signal), true);
});

test("isFatalWorkflowError classifies abort errors as fatal", () => {
  assert.equal(isFatalWorkflowError(new WorkflowAbortError("cancelled"), undefined), true);
  assert.equal(isFatalWorkflowError(new DOMException("cancelled", "AbortError"), undefined), true);
});

test("isFatalWorkflowError treats plain and budget errors as recoverable", () => {
  const controller = new AbortController();

  assert.equal(isFatalWorkflowError(new Error("boom"), controller.signal), false);
  assert.equal(isFatalWorkflowError(new WorkflowBudgetExceededError(10, 12), controller.signal), false);
});

test("runAgent marks queued row failed when semaphore acquisition aborts", async () => {
  const semaphore = new Semaphore(1);
  const progress = createProgress();
  const firstController = new AbortController();
  const queuedController = new AbortController();
  let releaseFirst: (() => void) | undefined;
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [] },
      async prompt() {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
    },
  });

  const first = runAgent(createRunContext(createSession, firstController.signal, progress, semaphore), "first", { label: "first" });
  await delay(1);
  const queued = runAgent(createRunContext(createSession, queuedController.signal, progress, semaphore), "queued", { label: "queued" });
  await delay(1);
  queuedController.abort(new WorkflowAbortError("queued stop"));

  await assert.rejects(queued, /queued stop/);
  releaseFirst?.();
  await first;
  assert.ok(progress.events.includes("failed:queued"), progress.events.join(","));
});

test("runAgent calls session.abort when the run signal aborts", async () => {
  const controller = new AbortController();
  let aborts = 0;
  let resolvePrompt: (() => void) | undefined;
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [] },
      async prompt() {
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {
        aborts += 1;
        resolvePrompt?.();
      },
    },
  });

  const running = runAgent(createRunContext(createSession, controller.signal), "hello", { label: "abort-me" });
  await delay(1);
  controller.abort(new WorkflowAbortError("stop"));

  await assert.rejects(running, /stop/);
  assert.equal(aborts, 1);
});
