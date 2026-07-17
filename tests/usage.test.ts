import assert from "node:assert/strict";
import { test } from "bun:test";
import { createWorkflowUsageRecorder, emptyWorkflowUsageTotals, formatWorkflowUsageLine } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

function assistantUsage(overrides: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  costInput?: number;
  costOutput?: number;
  costCacheRead?: number;
  costCacheWrite?: number;
  costTotal?: number;
  provider?: string;
  model?: string;
} = {}): unknown {
  const input = overrides.input ?? 10;
  const output = overrides.output ?? 5;
  const cacheRead = overrides.cacheRead ?? 0;
  const cacheWrite = overrides.cacheWrite ?? 0;
  return {
    role: "assistant",
    provider: overrides.provider,
    model: overrides.model,
    content: [{ type: "text", text: "ok" }],
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: 999999,
      cost: {
        input: overrides.costInput ?? 0.01,
        output: overrides.costOutput ?? 0.02,
        cacheRead: overrides.costCacheRead ?? 0,
        cacheWrite: overrides.costCacheWrite ?? 0,
        total: overrides.costTotal ?? 0.03,
      },
    },
  };
}

test("WorkflowUsageRecorder sums usage and cost across assistant messages", () => {
  const recorder = createWorkflowUsageRecorder();

  recorder.recordAgentSession({
    label: "finder",
    phase: "Find",
    messages: [
      assistantUsage({ input: 1000, output: 200, cacheRead: 3000, cacheWrite: 400, costInput: 0.01, costOutput: 0.02, costCacheRead: 0.003, costCacheWrite: 0.004, costTotal: 0.037 }),
      assistantUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40, costInput: 0.1, costOutput: 0.2, costCacheRead: 0.03, costCacheWrite: 0.04, costTotal: 0.37 }),
    ],
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.assistantMessages, 2);
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.agents[0]?.usage.input, 1010);
  assert.equal(snapshot.agents[0]?.usage.output, 220);
  assert.equal(snapshot.agents[0]?.usage.cacheRead, 3030);
  assert.equal(snapshot.agents[0]?.usage.cacheWrite, 440);
  assert.equal(snapshot.agents[0]?.usage.totalTokens, 4700);
  assert.deepEqual(snapshot.agents[0]?.usage.coverage, {
    input: "complete",
    output: "complete",
    cacheRead: "complete",
    cacheWrite: "complete",
  });
  assert.deepEqual(snapshot.totals, snapshot.agents[0]?.usage);
  assert.deepEqual(snapshot.totals.cost, { input: 0.11, output: 0.22, cacheRead: 0.033, cacheWrite: 0.044, total: 0.407 });
});

test("WorkflowUsageRecorder ignores non-assistant and malformed messages", () => {
  const recorder = createWorkflowUsageRecorder();

  recorder.recordAgentSession({
    label: "mixed",
    messages: [
      { role: "user", content: "ignore" },
      { role: "assistant", usage: { input: "bad" } },
      { role: "toolResult", content: [] },
      assistantUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costTotal: 0.01 }),
    ],
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.agents.length, 1);
  assert.equal(snapshot.assistantMessages, 1);
  assert.equal(snapshot.totals.totalTokens, 10);
  assert.equal(snapshot.totals.cost.total, 0.01);
});

test("WorkflowUsageRecorder preserves label phase and latest provider metadata", () => {
  const recorder = createWorkflowUsageRecorder();

  recorder.recordAgentSession({
    label: "synth",
    phase: "Synthesize",
    messages: [
      assistantUsage({ provider: "anthropic", model: "claude-a" }),
      assistantUsage({ provider: "openai", model: "gpt-b" }),
    ],
  });

  const agent = recorder.snapshot().agents[0];
  assert.equal(agent?.label, "synth");
  assert.equal(agent?.phase, "Synthesize");
  assert.equal(agent?.provider, "openai");
  assert.equal(agent?.model, "gpt-b");
  assert.equal(agent?.assistantMessages, 2);
});

test("WorkflowUsageRecorder empty input returns zero totals and no agents", () => {
  const recorder = createWorkflowUsageRecorder();

  recorder.recordAgentSession({ label: "empty", messages: [] });
  const snapshot = recorder.snapshot();

  assert.deepEqual(snapshot, { agents: [], totals: emptyWorkflowUsageTotals(), assistantMessages: 0 });
  assert.equal(formatWorkflowUsageLine(snapshot), undefined);
});

test("WorkflowUsageRecorder publishes snapshots after recorded agent sessions", () => {
  const published: WorkflowUsageSnapshot[] = [];
  const recorder = createWorkflowUsageRecorder((snapshot) => published.push(snapshot));

  recorder.recordAgentSession({ label: "empty", messages: [] });
  recorder.recordAgentSession({ label: "used", messages: [assistantUsage({ input: 4, output: 2 })] });

  assert.equal(published.length, 1);
  assert.deepEqual(published[0], recorder.snapshot());
});

test("formatWorkflowUsageLine ignores malformed snapshots", () => {
  assert.equal(formatWorkflowUsageLine({}), undefined);
  assert.equal(formatWorkflowUsageLine({ agents: [], assistantMessages: 1 }), undefined);
  assert.equal(formatWorkflowUsageLine({ agents: [], totals: {}, assistantMessages: 1 }), undefined);
});

test("formatWorkflowUsageLine separates fresh cached and output tokens", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "priced",
    messages: [assistantUsage({ input: 12345, output: 1800, cacheRead: 40000, cacheWrite: 5000, costTotal: 0.1234 })],
  });

  assert.equal(
    formatWorkflowUsageLine(recorder.snapshot()),
    "Usage: fresh 12k · cache read 40k · cache write 5.0k · output 1.8k · cost $0.123 · agents 1",
  );
});

test("formatWorkflowUsageLine omits zero cache components for uncached usage", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "uncached",
    messages: [assistantUsage({ input: 200, output: 50, cacheRead: 0, cacheWrite: 0, costTotal: 0.01 })],
  });

  assert.equal(formatWorkflowUsageLine(recorder.snapshot()), "Usage: fresh 200 · output 50 · cost $0.010 · agents 1");
});

test("formatWorkflowUsageLine preserves provider totals for partial usage", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "partial-provider",
    messages: [
      {
        role: "assistant",
        provider: "custom",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 50,
          totalTokens: 120,
          cost: { total: 0.05 },
        },
      },
    ],
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.totals.totalTokens, 120);
  assert.deepEqual(snapshot.totals.coverage, {
    input: "complete",
    output: "complete",
    cacheRead: "complete",
    cacheWrite: "none",
  });
  assert.equal(
    formatWorkflowUsageLine(snapshot),
    "Usage: input 100 · cache read 50 · output 20 · total 120 · cost $0.050 · agents 1",
  );
});

test("formatWorkflowUsageLine falls back to aggregate tokens without false component zeros", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "aggregate-provider",
    messages: [
      {
        role: "assistant",
        usage: {
          totalTokens: 700,
          cost: { total: 0.02 },
        },
      },
    ],
  });

  const snapshot = recorder.snapshot();
  assert.deepEqual(snapshot.totals.coverage, {
    input: "none",
    output: "none",
    cacheRead: "none",
    cacheWrite: "none",
  });
  assert.equal(formatWorkflowUsageLine(snapshot), "Usage: tokens 700 · cost $0.020 · agents 1");
});

test("WorkflowUsageRecorder sums mixed-provider totals without double-counting components", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "complete-provider",
    messages: [assistantUsage({ input: 100, output: 20, cacheRead: 50, cacheWrite: 0, costTotal: 0.01 })],
  });
  recorder.recordAgentSession({
    label: "aggregate-provider",
    messages: [{ role: "assistant", usage: { totalTokens: 400, cost: { total: 0.02 } } }],
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.totals.totalTokens, 570);
  assert.equal(
    snapshot.totals.totalTokens,
    snapshot.agents.reduce((total, agent) => total + agent.usage.totalTokens, 0),
  );
  assert.deepEqual(snapshot.totals.coverage, {
    input: "partial",
    output: "partial",
    cacheRead: "partial",
    cacheWrite: "partial",
  });
  assert.equal(snapshot.totals.cost.total, 0.03);
  assert.equal(
    formatWorkflowUsageLine(snapshot),
    "Usage: input ≥100 · cache read ≥50 · output ≥20 · total 570 · cost $0.030 · agents 2",
  );
});

test("formatWorkflowUsageLine suppresses true zero usage", () => {
  const recorder = createWorkflowUsageRecorder();
  recorder.recordAgentSession({
    label: "zero",
    messages: [
      assistantUsage({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0,
        costTotal: 0,
      }),
    ],
  });

  assert.equal(recorder.snapshot().assistantMessages, 1);
  assert.equal(formatWorkflowUsageLine(recorder.snapshot()), undefined);
});
