import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AssistantMessage, StopReason } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  WorkflowAgentLimitError,
  WorkflowAgentLimiter,
  WorkflowAgentTimeoutError,
} from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import {
  agentRetryDelayMs,
  providerErrorFromMessages,
  WorkflowProviderError,
  type AgentRetryScheduler,
} from "../.pi/extensions/pi-workflow-engine/src/agent-retry.ts";
import { WorkflowBudgetExceededError, createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { parallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { WorkflowStructuredOutputError } from "../.pi/extensions/pi-workflow-engine/src/structured-output.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { AgentRunnerSession, CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import {
  createProgress,
  createRunContext,
  runAgent,
} from "./agent-runner-fixtures.ts";

interface SessionScript {
  readonly messages: readonly AssistantMessage[];
  readonly onPrompt?: () => void;
}

interface ScriptedSessions {
  readonly createSession: CreateAgentSession;
  readonly sessionsCreated: () => number;
  readonly promptCalls: () => number;
  readonly disposeCalls: () => number;
  readonly autoRetrySettings: readonly boolean[];
}

function assistantMessage(input: {
  readonly stopReason?: StopReason;
  readonly errorMessage?: string;
  readonly text?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
} = {}): AssistantMessage {
  const inputTokens = input.inputTokens ?? 2;
  const outputTokens = input.outputTokens ?? 3;
  return {
    role: "assistant",
    content: [{ type: "text", text: input.text ?? "done" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-test",
    usage: {
      input: inputTokens,
      output: outputTokens,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: input.stopReason ?? "stop",
    ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
    timestamp: 1,
  };
}

function scriptedSessions(scripts: readonly SessionScript[]): ScriptedSessions {
  let sessionsCreated = 0;
  let promptCalls = 0;
  let disposeCalls = 0;
  const autoRetrySettings: boolean[] = [];
  const createSession: CreateAgentSession = async () => {
    const script = scripts[sessionsCreated];
    if (!script) throw new Error(`Missing session script ${sessionsCreated + 1}.`);
    sessionsCreated++;
    let messages: readonly AssistantMessage[] = [];
    const session: AgentRunnerSession = {
      get state() {
        return { messages };
      },
      async prompt() {
        promptCalls++;
        script.onPrompt?.();
        messages = script.messages;
      },
      subscribe() {
        return () => {};
      },
      dispose() {
        disposeCalls++;
      },
      async abort() {},
      setAutoRetryEnabled(enabled) {
        autoRetrySettings.push(enabled);
      },
    };
    return { session };
  };
  return {
    createSession,
    sessionsCreated: () => sessionsCreated,
    promptCalls: () => promptCalls,
    disposeCalls: () => disposeCalls,
    autoRetrySettings,
  };
}

function immediateScheduler(delays: number[]): AgentRetryScheduler {
  return {
    async sleep(delayMs, signal) {
      if (signal?.aborted) throw signal.reason;
      delays.push(delayMs);
    },
  };
}

test("provider classification requires failed assistant metadata", () => {
  const matchingTextWithoutFailure = assistantMessage({ text: "529 overloaded" });
  assert.equal(providerErrorFromMessages([matchingTextWithoutFailure]), undefined);
  assert.equal(providerErrorFromMessages([
    assistantMessage({ stopReason: "error", errorMessage: "503 old failure" }),
    assistantMessage({ text: "later success" }),
  ]), undefined);

  const transient = providerErrorFromMessages([
    assistantMessage({ stopReason: "error", errorMessage: "529 overloaded" }),
  ]);
  assert.ok(transient instanceof WorkflowProviderError);
  assert.equal(transient.message, "529 overloaded");
  assert.equal(transient.retryable, true);
  assert.deepEqual(transient.details, {
    stopReason: "error",
    retryable: true,
    provider: "anthropic",
    model: "claude-test",
    api: "anthropic-messages",
  });

  const quota = providerErrorFromMessages([
    assistantMessage({ stopReason: "error", errorMessage: "429 insufficient_quota" }),
  ]);
  assert.ok(quota instanceof WorkflowProviderError);
  assert.equal(quota.retryable, false);
});

test("retry delays are deterministic exponential backoff with a cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 20].map(agentRetryDelayMs),
    [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000],
  );
});

test("runAgent retries a transient provider failure in the same progress row", async () => {
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 service unavailable", outputTokens: 4 })] },
    { messages: [assistantMessage({ text: "recovered", outputTokens: 2 })] },
  ]);
  const delays: number[] = [];
  const progress = createProgress();
  const usage = createWorkflowUsageRecorder();
  const result = await runAgent(
    createRunContext({
      createSession: sessions.createSession,
      agentRetries: 1,
      retryScheduler: immediateScheduler(delays),
      progress,
      usage,
    }),
    "hello",
    { label: "retrying", phase: "Find" },
  );

  assert.equal(result, "recovered");
  assert.deepEqual(delays, [1_000]);
  assert.equal(sessions.sessionsCreated(), 2);
  assert.equal(sessions.promptCalls(), 2);
  assert.equal(sessions.disposeCalls(), 2);
  assert.deepEqual(sessions.autoRetrySettings, [false, false]);
  assert.equal(progress.events.filter((event) => event === "queued:retrying").length, 1);
  assert.equal(progress.events.filter((event) => event === "start:retrying").length, 1);
  assert.equal(progress.events.filter((event) => event === "done:retrying").length, 1);
  assert.equal(progress.events.some((event) => event.startsWith("failed:retrying")), false);
  assert.equal(progress.events.some((event) => event.includes("retry 1/1 in 1000ms")), true);
  assert.equal(usage.snapshot().agents.length, 2);
  assert.equal(usage.snapshot().totals.output, 6);
});

test("runAgent surfaces the final typed provider failure after retry exhaustion", async () => {
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "network error: reset" })] },
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 still unavailable" })] },
  ]);
  const delays: number[] = [];
  const progress = createProgress();
  let failure: unknown;
  try {
    await runAgent(
      createRunContext({
        createSession: sessions.createSession,
        agentRetries: 1,
        retryScheduler: immediateScheduler(delays),
        progress,
      }),
      "hello",
      { label: "exhausted" },
    );
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof WorkflowProviderError);
  assert.equal(failure.message, "503 still unavailable");
  assert.equal(failure.retryable, true);
  assert.deepEqual(delays, [1_000]);
  assert.equal(progress.events.filter((event) => event.startsWith("failed:exhausted")).length, 1);
  assert.equal(progress.events.some((event) => event.includes("after 1 retries; giving up")), true);
});

test("runAgent does not retry non-transient provider or schema failures", async () => {
  const quotaSessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "429 insufficient_quota" })] },
  ]);
  const quotaDelays: number[] = [];
  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: quotaSessions.createSession,
        agentRetries: 3,
        retryScheduler: immediateScheduler(quotaDelays),
      }),
      "hello",
      { label: "quota" },
    ),
    (error) => error instanceof WorkflowProviderError && error.retryable === false,
  );
  assert.deepEqual(quotaDelays, []);
  assert.equal(quotaSessions.sessionsCreated(), 1);

  const schemaSessions = scriptedSessions([
    { messages: [assistantMessage({ text: "plain text only" })] },
  ]);
  const schemaDelays: number[] = [];
  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: schemaSessions.createSession,
        agentRetries: 3,
        retryScheduler: immediateScheduler(schemaDelays),
      }),
      "hello",
      { label: "schema", schema: Type.Object({ ok: Type.Boolean() }) },
    ),
    WorkflowStructuredOutputError,
  );
  assert.deepEqual(schemaDelays, []);
  assert.equal(schemaSessions.sessionsCreated(), 1);
  assert.equal(schemaSessions.promptCalls(), 3);
});

test("provider retries remain inside the original abort scope", async () => {
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "network timeout" })] },
  ]);
  const controller = new AbortController();
  const abortError = new WorkflowAbortError("host cancelled during retry delay");
  const scheduler: AgentRetryScheduler = {
    async sleep(_delayMs, signal) {
      controller.abort(abortError);
      assert.equal(signal?.aborted, true);
      throw signal?.reason;
    },
  };

  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: sessions.createSession,
        agentRetries: 2,
        retryScheduler: scheduler,
        signal: controller.signal,
      }),
      "hello",
      { label: "cancelled" },
    ),
    (error) => error === abortError,
  );
  assert.equal(sessions.sessionsCreated(), 1);
});

test("retry backoff cannot outlive the original agent timeout", async () => {
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "network timeout" })] },
  ]);
  const scheduler: AgentRetryScheduler = {
    async sleep(_delayMs, signal) {
      await new Promise<void>((_resolve, reject) => {
        const onAbort = () => reject(signal?.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      });
    },
  };

  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: sessions.createSession,
        agentRetries: 1,
        agentTimeoutMs: 5,
        retryScheduler: scheduler,
      }),
      "hello",
      { label: "timed-out" },
    ),
    WorkflowAgentTimeoutError,
  );
  assert.equal(sessions.sessionsCreated(), 1);
});

test("failed-attempt usage can exhaust the budget before a retry starts", async () => {
  const usage = createWorkflowUsageRecorder();
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 overloaded", outputTokens: 5 })] },
  ]);
  const delays: number[] = [];
  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: sessions.createSession,
        agentRetries: 2,
        retryScheduler: immediateScheduler(delays),
        usage,
        budget: createBudget(5, usage),
      }),
      "hello",
      { label: "budgeted" },
    ),
    WorkflowBudgetExceededError,
  );
  assert.deepEqual(delays, []);
  assert.equal(sessions.sessionsCreated(), 1);
  assert.equal(usage.snapshot().totals.output, 5);
});

test("each retry consumes live-agent admission", async () => {
  const sessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 overloaded" })] },
    { messages: [assistantMessage({ text: "must not be prompted" })] },
  ]);
  const delays: number[] = [];
  await assert.rejects(
    () => runAgent(
      createRunContext({
        createSession: sessions.createSession,
        agentRetries: 1,
        retryScheduler: immediateScheduler(delays),
        agentLimiter: new WorkflowAgentLimiter(1),
      }),
      "hello",
      { label: "limited" },
    ),
    WorkflowAgentLimitError,
  );
  assert.deepEqual(delays, [1_000]);
  assert.equal(sessions.sessionsCreated(), 2);
  assert.equal(sessions.promptCalls(), 1);
  assert.equal(sessions.disposeCalls(), 2);
});

test("exhausted provider failures keep parallel default and settled semantics", async () => {
  const defaultSessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 overloaded" })] },
  ]);
  const defaults = await parallel([
    () => runAgent(
      createRunContext({ createSession: defaultSessions.createSession }),
      "hello",
      { label: "default" },
    ),
  ]);
  assert.deepEqual(defaults, [null]);

  const settledSessions = scriptedSessions([
    { messages: [assistantMessage({ stopReason: "error", errorMessage: "503 overloaded" })] },
  ]);
  const settled = await parallel([
    () => runAgent(
      createRunContext({ createSession: settledSessions.createSession }),
      "hello",
      { label: "settled" },
    ),
  ], { settled: true });
  assert.deepEqual(settled, [{
    ok: false,
    error: {
      name: "WorkflowProviderError",
      message: "503 overloaded",
      code: "WORKFLOW_PROVIDER_ERROR",
      details: {
        stopReason: "error",
        retryable: true,
        provider: "anthropic",
        model: "claude-test",
        api: "anthropic-messages",
      },
    },
  }]);
});
