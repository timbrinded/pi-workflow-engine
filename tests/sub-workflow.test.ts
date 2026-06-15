import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { runWorkflowWithContext, type WorkflowContextOptions, type WorkflowProgress } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { AgentProgress, CreateAgentSession, RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import type { WorkflowModule, WorkflowRef } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { resolveWorkflowRef } from "../.pi/extensions/pi-workflow-engine/index.ts";

interface CaptureProgress extends AgentProgress, WorkflowProgress {
  readonly phases: string[];
  readonly logs: string[];
}

function createProgress(): CaptureProgress {
  const phases: string[] = [];
  const logs: string[] = [];
  let id = 0;
  return {
    phases,
    logs,
    agentQueued: () => ++id,
    agentStart: () => {},
    agentTool: () => {},
    agentDone: () => {},
    agentFailed: () => {},
    log: (message) => logs.push(message),
    phase: (title) => phases.push(title),
    event: () => {},
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
  return { abortController: new AbortController(), submissionLimit: 16, resolveWorkflow, depth: 0, phasePrefix: "" };
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

test("api.workflow() nests only one level deep", async () => {
  const progress = createProgress();
  const rc = createRc(progress, new Semaphore(4));
  const grandchild = workflowModule("grandchild", async (api) => api.workflow("anything"));
  const parent = workflowModule("parent", async (api) => api.workflow("grandchild"));

  await assert.rejects(
    () => runWorkflowWithContext(rc, progress, parent, "", contextOpts(async () => grandchild)),
    /one level deep/,
  );
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
  const mod = await resolveWorkflowRef(process.cwd(), "code-review");
  assert.equal(mod.meta.name, "code-review");
});

test("resolveWorkflowRef rejects an unknown name", async () => {
  await assert.rejects(() => resolveWorkflowRef(process.cwd(), "does-not-exist"), /Unknown workflow/);
});

test("resolveWorkflowRef rejects a scriptPath outside the repo", async () => {
  await assert.rejects(() => resolveWorkflowRef(process.cwd(), { scriptPath: "../../../../etc/passwd" }), /escapes the repo/);
});

test("resolveWorkflowRef compiles an inline-style script file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-subwf-"));
  try {
    await writeFile(
      join(dir, "inline.ts"),
      'export const meta = { name: "from-file", description: "x" };\nexport default async function run({ args }) { return args; }\n',
    );
    const mod = await resolveWorkflowRef(dir, { scriptPath: "inline.ts" });
    assert.equal(mod.meta.name, "from-file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
