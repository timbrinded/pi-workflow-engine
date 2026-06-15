import assert from "node:assert/strict";
import { test } from "bun:test";
import { runWorkflowWithContext, type WorkflowContextOptions, type WorkflowProgress } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { AgentProgress, CreateAgentSession, RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import type { WorkflowModule, WorkflowProgressEvent, WorkflowRef } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { resolveWorkflowRef } from "../.pi/extensions/pi-workflow-engine/index.ts";

interface CaptureProgress extends AgentProgress, WorkflowProgress {
  readonly phases: string[];
  readonly logs: string[];
  readonly events: WorkflowProgressEvent[];
  readonly agents: Array<{ readonly phase: string | undefined; readonly label: string }>;
}

function createProgress(): CaptureProgress {
  const phases: string[] = [];
  const logs: string[] = [];
  const events: WorkflowProgressEvent[] = [];
  const agents: Array<{ readonly phase: string | undefined; readonly label: string }> = [];
  let id = 0;
  return {
    phases,
    logs,
    events,
    agents,
    agentQueued: (phase, label) => {
      agents.push({ phase, label });
      return ++id;
    },
    agentStart: () => {},
    agentTool: () => {},
    agentDone: () => {},
    agentFailed: () => {},
    log: (message) => logs.push(message),
    phase: (title) => phases.push(title),
    event: (event) => events.push(event),
  };
}

function createRc(progress: CaptureProgress, semaphore: Semaphore, createSession?: CreateAgentSession): RunContext {
  return {
    cwd: process.cwd(),
    hostModel: undefined,
    modelRegistry: { find: () => undefined },
    semaphore,
    progress,
    signal: undefined,
    perf: new PerfRecorder(),
    createSession,
  };
}

function workflowModule(name: string, run: WorkflowModule["default"]): WorkflowModule {
  return { meta: { name, description: "" }, default: run };
}

function contextOpts(resolveWorkflow?: (ref: WorkflowRef) => Promise<WorkflowModule>): WorkflowContextOptions {
  return { abortController: new AbortController(), submissionLimit: 16, resolveWorkflow, depth: 0, progressPrefix: "" };
}

const NOOP_SESSION: CreateAgentSession = async () => ({
  session: {
    state: { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] },
    prompt: async () => {},
    subscribe: () => () => {},
    dispose: () => {},
    abort: async () => {},
  },
});

function eventByKey(events: readonly WorkflowProgressEvent[], key: string): WorkflowProgressEvent | undefined {
  return events.find((event) => "key" in event && event.key === key);
}

function laneEvent(events: readonly WorkflowProgressEvent[], lane: string): WorkflowProgressEvent | undefined {
  return events.find((event) => event.type === "lane_item" && event.lane === lane);
}

test("api.workflow() runs a resolved sub-workflow and returns its result", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const child = workflowModule("child", async () => "child-result");
  const parent = workflowModule("parent", async (api) => api.workflow("child"));

  const result = await runWorkflowWithContext(
    rc,
    progress,
    parent,
    "",
    contextOpts(async (ref) => {
      if (ref === "child") return child;
      throw new Error(`unexpected ref ${String(ref)}`);
    }),
  );

  assert.equal(result, "child-result");
});

test("api.workflow() passes args through to the child", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const child = workflowModule("child", async (api) => `got:${api.args}`);
  const parent = workflowModule("parent", async (api) => api.workflow("child", "payload"));

  const result = await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  assert.equal(result, "got:payload");
});

test("api.workflow() nesting rejection is promise-shaped", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const catchChild = workflowModule("catch-child", async (api) =>
    api.workflow("anything").catch((error: unknown) => (error instanceof Error ? `caught:${error.message}` : "caught")),
  );
  const tryChild = workflowModule("try-child", async (api) => {
    try {
      await api.workflow("anything");
    } catch (error) {
      return error instanceof Error ? `caught:${error.message}` : "caught";
    }
    return "not caught";
  });
  const catchParent = workflowModule("parent", async (api) => api.workflow("catch-child"));
  const tryParent = workflowModule("parent", async (api) => api.workflow("try-child"));

  const catchResult = await runWorkflowWithContext(rc, progress, catchParent, "", contextOpts(async () => catchChild));
  const tryResult = await runWorkflowWithContext(rc, progress, tryParent, "", contextOpts(async () => tryChild));

  assert.equal(catchResult, "caught:workflow() can only nest one level deep");
  assert.equal(tryResult, "caught:workflow() can only nest one level deep");
});

test("api.workflow() throws when no resolver is configured", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const parent = workflowModule("parent", async (api) => api.workflow("child"));

  await assert.rejects(() => runWorkflowWithContext(rc, progress, parent, "", contextOpts(undefined)), /not enabled/);
});

test("sub-workflow phases nest under '<name> ▸ <title>'", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const child = workflowModule("reviewer", async (api) => {
    api.phase("Scan");
    return "ok";
  });
  const parent = workflowModule("parent", async (api) => {
    api.phase("Top");
    await api.workflow("reviewer");
    return "done";
  });

  await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  assert.ok(progress.phases.includes("Top"), `expected parent phase, got ${JSON.stringify(progress.phases)}`);
  assert.ok(progress.phases.includes("reviewer ▸ Scan"), `expected nested phase, got ${JSON.stringify(progress.phases)}`);
});

test("parent agents after a sub-workflow stay in the parent phase", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4), NOOP_SESSION);
  const child = workflowModule("reviewer", async (api) => {
    api.phase("Scan");
    return "ok";
  });
  const parent = workflowModule("parent", async (api) => {
    api.phase("Top");
    await api.workflow("reviewer");
    await api.agent("after child", { label: "after-child", thinkingLevel: "low" });
    return "done";
  });

  await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  assert.deepEqual(
    progress.agents.find((agent) => agent.label === "after-child"),
    { phase: "Top", label: "after-child" },
  );
});

test("child structured progress is namespaced while parent progress is not", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const child = workflowModule("reviewer", async (api) => {
    api.log("child log");
    api.progress({ type: "counter", key: "kept", label: "kept", value: 1 });
    api.progress({ type: "summary", key: "target", value: "child" });
    api.progress({ type: "lane_item", lane: "Findings", title: "Child finding", status: "success" });
    return "ok";
  });
  const parent = workflowModule("parent", async (api) => {
    api.log("parent log");
    api.progress({ type: "counter", key: "kept", label: "kept", value: 2 });
    api.progress({ type: "summary", key: "target", value: "parent" });
    api.progress({ type: "lane_item", lane: "Findings", title: "Parent finding", status: "pending" });
    await api.workflow("reviewer");
    return "done";
  });

  await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  assert.deepEqual(eventByKey(progress.events, "kept"), { type: "counter", key: "kept", label: "kept", value: 2 });
  assert.deepEqual(eventByKey(progress.events, "reviewer.kept"), { type: "counter", key: "reviewer.kept", label: "kept", value: 1 });
  assert.deepEqual(eventByKey(progress.events, "target"), { type: "summary", key: "target", value: "parent" });
  assert.deepEqual(eventByKey(progress.events, "reviewer.target"), { type: "summary", key: "reviewer.target", value: "child" });
  assert.equal(laneEvent(progress.events, "Findings")?.type, "lane_item");
  assert.equal(laneEvent(progress.events, "reviewer ▸ Findings")?.type, "lane_item");
  assert.ok(progress.logs.includes("parent log"));
  assert.ok(progress.logs.includes("reviewer: child log"));
});

test("parent and sub-workflow agents share the run's concurrency cap", async () => {
  let active = 0;
  let max = 0;
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] },
      async prompt() {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
      subscribe: () => () => {},
      dispose: () => {},
      abort: async () => {},
    },
  });

  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(1), createSession);
  const child = workflowModule("child", async (api) => {
    await api.parallel([() => api.agent("c1"), () => api.agent("c2")]);
    return "child";
  });
  const parent = workflowModule("parent", async (api) => {
    await api.parallel([() => api.agent("p1"), () => api.workflow("child")]);
    return "done";
  });

  await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  // Semaphore(1) is shared across the parent and the sub-workflow, so no two agents run at once.
  assert.equal(max, 1);
});

test("resolveWorkflowRef resolves a registered workflow by name", async () => {
  const mod = await resolveWorkflowRef("code-review");
  assert.equal(mod.meta.name, "code-review");
});

test("resolveWorkflowRef rejects an unknown name", async () => {
  await assert.rejects(() => resolveWorkflowRef("does-not-exist"), /Unknown workflow/);
});
