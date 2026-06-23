import assert from "node:assert/strict";
import { test } from "bun:test";
import { Type } from "typebox";
import { runAgent, type AgentProgress, type CreateAgentSession, type RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder, type WorkflowUsageSink } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

function createProgress(): AgentProgress & { readonly events: string[] } {
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
    agentTool(label, tool) {
      events.push(`tool:${label}:${tool}`);
    },
    agentDone(label) {
      events.push(`done:${label}`);
    },
    agentFailed(label, error) {
      events.push(`failed:${label}:${String(error)}`);
    },
    log(message) {
      events.push(`log:${message}`);
    },
  };
}

function aggregateNames(recorder: PerfRecorder): string[] {
  return recorder.snapshot().aggregates.map((aggregate) => aggregate.name).sort();
}

function createRunContext(createSession: CreateAgentSession, perf: PerfRecorder, usage: WorkflowUsageSink = createWorkflowUsageRecorder()): RunContext {
  return {
    cwd: process.cwd(),
    hostModel: undefined,
    modelRegistry: { find: () => undefined },
    semaphore: new Semaphore(1),
    progress: createProgress(),
    signal: undefined,
    perf,
    usage,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    createSession,
  };
}

function usageAssistant(input: number, output: number, costTotal: number): unknown {
  return {
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [{ type: "text", text: "done" }],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: costTotal / 2, output: costTotal / 2, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
  };
}

test("runAgent records lifecycle timing samples without LLM calls", async () => {
  const perf = new PerfRecorder();
  let disposed = 0;
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      dispose() {
        disposed += 1;
      },
      async abort() {},
    },
  });

  const result = await runAgent(createRunContext(createSession, perf), "hello", { label: "timed", phase: "Test" });

  assert.equal(result, "done");
  assert.equal(disposed, 1);
  assert.deepEqual(aggregateNames(perf), [
    "agent.create_session_ms",
    "agent.dispose_ms",
    "agent.extract_result_ms",
    "agent.prompt_ms",
    "agent.queue_wait_ms",
    "agent.total_ms",
  ]);
  const queueWait = perf.snapshot().aggregates.find((aggregate) => aggregate.name === "agent.queue_wait_ms");
  assert.equal(queueWait?.count, 1);
});

test("runAgent records usage before disposing a successful subagent session", async () => {
  const perf = new PerfRecorder();
  const usage = createWorkflowUsageRecorder();
  let messages: readonly unknown[] = [usageAssistant(100, 25, 0.0125)];
  const createSession: CreateAgentSession = async () => ({
    session: {
      get state() {
        return { messages };
      },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      dispose() {
        messages = [];
      },
      async abort() {},
    },
  });

  const result = await runAgent(createRunContext(createSession, perf, usage), "hello", { label: "usage", phase: "Find" });

  assert.equal(result, "done");
  const snapshot = usage.snapshot();
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]?.label, "usage");
  assert.equal(snapshot.agents[0]?.phase, "Find");
  assert.equal(snapshot.totals.input, 100);
  assert.equal(snapshot.totals.output, 25);
  assert.equal(snapshot.totals.cost.total, 0.0125);
});

test("runAgent records usage before disposing a failed subagent session", async () => {
  const perf = new PerfRecorder();
  const usage = createWorkflowUsageRecorder();
  let messages: readonly unknown[] = [usageAssistant(40, 10, 0.005)];
  const createSession: CreateAgentSession = async () => ({
    session: {
      get state() {
        return { messages };
      },
      async prompt() {
        throw new Error("prompt failed");
      },
      subscribe() {
        return () => {};
      },
      dispose() {
        messages = [];
      },
      async abort() {},
    },
  });

  await assert.rejects(() => runAgent(createRunContext(createSession, perf, usage), "hello", { label: "failed", phase: "Verify" }), /prompt failed/);

  const snapshot = usage.snapshot();
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]?.label, "failed");
  assert.equal(snapshot.agents[0]?.phase, "Verify");
  assert.equal(snapshot.totals.input, 40);
  assert.equal(snapshot.totals.output, 10);
  assert.equal(snapshot.totals.cost.total, 0.005);
});

test("runAgent records missing structured output", async () => {
  const perf = new PerfRecorder();
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [] },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
    },
  });

  const result = await runAgent(createRunContext(createSession, perf), "hello", {
    label: "structured",
    schema: Type.Object({ ok: Type.Boolean() }),
  });

  assert.equal(result, null);
  assert.equal(perf.snapshot().aggregates.find((aggregate) => aggregate.name === "agent.structured_missing")?.total, 1);
});
