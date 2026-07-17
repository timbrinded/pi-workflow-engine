import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  runWorkflowWithContext,
  type WorkflowContextOptions,
  type WorkflowProgress,
  type WorkflowRunContext,
} from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { WorkflowAgentLimiter } from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import { DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS, DEFAULT_WORKFLOW_MAX_AGENTS } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder, type WorkflowUsageSink } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { AgentProgress, CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressEvent, WorkflowRef } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { resolveWorkflowRef } from "../.pi/extensions/pi-workflow-engine/index.ts";
import { createMemoryBackedJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { WorktreeRegistry, type WorktreeGitCommandOptions } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";

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

function createRc(
  progress: CaptureProgress,
  semaphore: Semaphore,
  createSession: CreateAgentSession = async () => {
    throw new Error("No session fixture configured");
  },
  usage: WorkflowUsageSink = createWorkflowUsageRecorder(),
): WorkflowRunContext {
  return {
    cwd: process.cwd(),
    hostModel: undefined,
    modelRegistry: { find: () => undefined },
    semaphore,
    agentLimiter: new WorkflowAgentLimiter(DEFAULT_WORKFLOW_MAX_AGENTS),
    agentTimeoutMs: DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
    progress,
    signal: undefined,
    perf: new PerfRecorder(),
    usage,
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    journal: createMemoryBackedJournal(),
    worktrees: new WorktreeRegistry(process.cwd()),
    createSession,
  };
}

function workflowModule(name: string, run: WorkflowModule["default"]): LoadedWorkflow {
  return {
    meta: { name, description: "" },
    default: run,
    source: { kind: "fingerprint", fingerprint: `sub-workflow-test:${name}:${run.toString()}` },
  };
}

function contextOpts(resolveWorkflow?: (ref: WorkflowRef) => Promise<LoadedWorkflow>): WorkflowContextOptions {
  return { abortController: new AbortController(), submissionLimit: 16, resolveWorkflow, depth: 0, progressPrefix: "" };
}

function usageMessage(input: number, output: number): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: input / 1000000, output: output / 1000000, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1000000 },
    },
  };
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

test("engine execution metadata injects the reviewed baseline into isolated worktree creation", async () => {
  const progress = createProgress();
  const baselineRef = "0123456789012345678901234567890123456789";
  const gitCalls: WorktreeGitCommandOptions[] = [];
  const worktrees = new WorktreeRegistry(process.cwd(), {
    runner: {
      async runGit(options) {
        gitCalls.push(options);
        let stdout = "";
        if (options.args.includes("--is-inside-work-tree")) stdout = "true\n";
        else if (options.args[0] === "rev-parse") stdout = `${baselineRef}\n`;
        return { ok: true, stdout, stderr: "" };
      },
    },
    patchCapture: async () => ({ patch: "", changed: false }),
  });
  let sessionCwd: string | undefined;
  const createSession: CreateAgentSession = async (options) => {
    sessionCwd = options.cwd;
    return await NOOP_SESSION(options);
  };
  const baseline = {
    ref: baselineRef,
    patch: "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-before\n+reviewed\n",
  };
  const mod: LoadedWorkflow = {
    ...workflowModule("baseline-injection", async (api) => await api.agent("fix", { isolation: "worktree" })),
    isolatedWorktreeBaseline: baseline,
  };
  const rc: WorkflowRunContext = {
    ...createRc(progress, new Semaphore(1), createSession),
    worktrees,
  };

  const result = await runWorkflowWithContext(rc, progress, mod, "", contextOpts());

  assert.deepEqual(result, { result: "ok", patch: "", changed: false });
  assert.match(sessionCwd ?? "", /pi-workflow-/);
  const add = gitCalls.find((call) => call.args[0] === "worktree" && call.args[1] === "add");
  assert.equal(add?.args.at(-1), baseline.ref);
  const apply = gitCalls.find((call) => call.args[0] === "apply");
  assert.equal(apply?.stdin, baseline.patch);
});

test("runWorkflowWithContext does not enter a workflow aborted after source capture starts", async () => {
  const progress = createProgress();
  const controller = new AbortController();
  const rc: WorkflowRunContext = { ...createRc(progress, new Semaphore(1)), signal: controller.signal };
  let workflowExecuted = false;
  const mod: LoadedWorkflow = {
    meta: { name: "cancel-before-default", description: "" },
    source: { kind: "fingerprint", fingerprint: "stable-source" },
    default: async () => {
      workflowExecuted = true;
      return "unexpected";
    },
  };
  queueMicrotask(() => controller.abort(new Error("cancel before workflow default")));

  await assert.rejects(
    () =>
      runWorkflowWithContext(rc, progress, mod, "", {
        abortController: controller,
        submissionLimit: 1,
      }),
    /cancel before workflow default/,
  );
  assert.equal(workflowExecuted, false);
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

test("parent and sub-workflow agents share the run's usage recorder", async () => {
  const usage = createWorkflowUsageRecorder();
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [usageMessage(10, 5)] },
      prompt: async () => {},
      subscribe: () => () => {},
      dispose: () => {},
      abort: async () => {},
    },
  });
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(2), createSession, usage);
  const child = workflowModule("child", async (api) => api.agent("child", { label: "child-agent" }));
  const parent = workflowModule("parent", async (api) => {
    const parentResult = await api.agent("parent", { label: "parent-agent" });
    const childResult = await api.workflow("child");
    return `${parentResult}/${String(childResult)}`;
  });

  const result = await runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child));

  assert.equal(result, "ok/ok");
  const snapshot = usage.snapshot();
  assert.deepEqual(
    snapshot.agents.map((agent) => agent.label).sort(),
    ["child-agent", "parent-agent"],
  );
  assert.equal(snapshot.assistantMessages, 2);
  assert.equal(snapshot.totals.input, 20);
  assert.equal(snapshot.totals.output, 10);
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

test("parent and sub-workflow agents share the run's live-agent limit", async () => {
  const progress = createProgress();
  const limiter = new WorkflowAgentLimiter(1);
  const rc: WorkflowRunContext = {
    ...createRc(progress, new Semaphore(1), NOOP_SESSION),
    agentLimiter: limiter,
  };
  const child = workflowModule("child", async (api) => await api.agent("child"));
  const parent = workflowModule("parent", async (api) => {
    await api.agent("parent");
    return await api.workflow("child");
  });

  await assert.rejects(
    () => runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => child)),
    /live-agent limit of 1/,
  );
});

test("resolveWorkflowRef resolves a registered workflow by name", async () => {
  const mod = await resolveWorkflowRef("code-review");
  assert.equal(mod.meta.name, "code-review");
});

test("resolveWorkflowRef rejects an unknown name", async () => {
  await assert.rejects(() => resolveWorkflowRef("does-not-exist"), /Unknown workflow/);
});
