import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow, runWorkflowWithContext, type WorkflowContextOptions, type WorkflowProgress } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import type { AgentProgress, CreateAgentSession, RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import {
  createWorkflowJournal,
  loadJournalEntries,
  workflowJournalPath,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { NoopPerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { WorkflowModule, WorkflowProgressEvent, WorkflowRef, WorkflowRunMetadata } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { WorktreeRegistry } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";

interface CaptureProgress extends AgentProgress, WorkflowProgress {
  readonly logs: string[];
}

function createProgress(): CaptureProgress {
  const logs: string[] = [];
  return {
    logs,
    agentQueued() {
      return 1;
    },
    agentStart() {},
    agentTool() {},
    agentDone() {},
    agentFailed() {},
    phase() {},
    event(_event: WorkflowProgressEvent) {},
    log(message) {
      logs.push(message);
    },
  };
}

function workflowModule(name: string, run: WorkflowModule["default"]): WorkflowModule {
  return { meta: { name, description: "" }, default: run };
}

function contextOpts(resolveWorkflow?: (ref: WorkflowRef) => Promise<WorkflowModule>): WorkflowContextOptions {
  return { abortController: new AbortController(), submissionLimit: 16, resolveWorkflow, depth: 0, progressPrefix: "" };
}

function createLiveTextSession(onPrompt: (prompt: string) => void): CreateAgentSession {
  return async () => {
    let messages: readonly unknown[] = [];
    return {
      session: {
        get state() {
          return { messages };
        },
        async prompt(prompt) {
          onPrompt(prompt);
          messages = [{ role: "assistant", content: [{ type: "text", text: `live:${prompt}` }] }];
        },
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
      },
    };
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDelayedTextSession(delays: Record<string, number>, onPrompt: (prompt: string) => void): CreateAgentSession {
  return async () => {
    let messages: readonly unknown[] = [];
    return {
      session: {
        get state() {
          return { messages };
        },
        async prompt(prompt) {
          onPrompt(prompt);
          await delay(delays[prompt] ?? 0);
          messages = [{ role: "assistant", content: [{ type: "text", text: `live:${prompt}` }] }];
        },
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
      },
    };
  };
}

function createSequencedTextSession(onPrompt: (prompt: string) => void): CreateAgentSession {
  let next = 0;
  return async () => {
    const sequence = ++next;
    let messages: readonly unknown[] = [];
    return {
      session: {
        get state() {
          return { messages };
        },
        async prompt(prompt) {
          onPrompt(prompt);
          messages = [{ role: "assistant", content: [{ type: "text", text: `live-${sequence}:${prompt}` }] }];
        },
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
      },
    };
  };
}

async function runWithJournal(input: {
  readonly cwd: string;
  readonly mod: WorkflowModule;
  readonly resumeFrom?: string;
  readonly writeRunId: string;
  readonly createSession: CreateAgentSession;
  readonly resolveWorkflow?: (ref: WorkflowRef) => Promise<WorkflowModule>;
}): Promise<unknown> {
  const usage = createWorkflowUsageRecorder();
  const progress = createProgress();
  const journal = await createWorkflowJournal({
    resumePath: input.resumeFrom ? workflowJournalPath(input.cwd, input.resumeFrom) : undefined,
    writePath: workflowJournalPath(input.cwd, input.writeRunId),
  });
  const rc: RunContext = {
    cwd: input.cwd,
    hostModel: undefined,
    modelRegistry: { find: () => undefined },
    semaphore: new Semaphore(4),
    progress,
    signal: undefined,
    perf: new NoopPerfRecorder(),
    usage,
    budget: createBudget(null, usage),
    journal,
    worktrees: new WorktreeRegistry(input.cwd),
    createSession: input.createSession,
  };

  return await runWorkflowWithContext(rc, progress, input.mod, "", contextOpts(input.resolveWorkflow));
}

function fakeContext(cwd: string): ExtensionContext {
  return {
    hasUI: false,
    cwd,
    model: undefined,
    modelRegistry: { find: () => undefined },
    signal: undefined,
  } as unknown as ExtensionContext;
}

test("resume with the same workflow replays all completed agent results from journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-"));
  let livePrompts: string[] = [];
  const mod = workflowModule("linear", async (api) => {
    const first = await api.agent("first");
    const second = await api.agent("second");
    return [first, second];
  });

  const firstResult = await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });
  assert.deepEqual(firstResult, ["live:first", "live:second"]);
  assert.equal(livePrompts.length, 2);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).length, 2);

  livePrompts = [];
  const resumedResult = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(resumedResult, ["live:first", "live:second"]);
  assert.deepEqual(livePrompts, []);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "second-run"))).length, 2);
});

test("resume misses changed calls without invalidating unrelated later calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-suffix-"));
  const original = workflowModule("linear", async (api) => [await api.agent("a"), await api.agent("b"), await api.agent("c")]);
  const changed = workflowModule("linear", async (api) => [await api.agent("a"), await api.agent("changed"), await api.agent("c")]);

  await runWithJournal({
    cwd,
    mod: original,
    writeRunId: "first-run",
    createSession: createLiveTextSession(() => {}),
  });

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod: changed,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:a", "live:changed", "live:c"]);
  assert.deepEqual(livePrompts, ["changed"]);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "second-run"))).length, 3);
});

test("parallel resume replays stable keys despite completion-order journal writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-parallel-"));
  const mod = workflowModule("parallel", async (api) => await api.parallel([() => api.agent("slow"), () => api.agent("fast")]));

  await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createDelayedTextSession({ slow: 20, fast: 0 }, () => {}),
  });
  assert.deepEqual(
    (await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).map((entry) => entry.value),
    ["live:fast", "live:slow"],
  );

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createDelayedTextSession({}, (prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:slow", "live:fast"]);
  assert.deepEqual(livePrompts, []);
});

test("pipeline resume replays later stages by stable item keys", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-pipeline-"));
  const mod = workflowModule("pipeline", async (api) =>
    await api.pipeline(
      ["slow", "fast"],
      async (_acc, item) => await api.agent(`stage1:${item}`),
      async (acc, item) => `${acc}|${await api.agent(`stage2:${item}`)}`,
    ),
  );

  await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createDelayedTextSession({ "stage1:slow": 20, "stage1:fast": 0 }, () => {}),
  });

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createDelayedTextSession({}, (prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:stage1:slow|live:stage2:slow", "live:stage1:fast|live:stage2:fast"]);
  assert.deepEqual(livePrompts, []);
});

test("cacheKey disambiguates repeated identical agent prompts for resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-cache-key-"));
  const mod = workflowModule("repeated", async (api) =>
    await api.parallel([
      () => api.agent("same", { cacheKey: "item:a" }),
      () => api.agent("same", { cacheKey: "item:b" }),
    ]),
  );

  const first = await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createSequencedTextSession(() => {}),
  });

  const livePrompts: string[] = [];
  const resumed = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createSequencedTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(first, ["live-1:same", "live-2:same"]);
  assert.deepEqual(resumed, first);
  assert.deepEqual(livePrompts, []);
});

test("sub-workflow agents share the same resume journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-child-"));
  const child = workflowModule("child", async (api) => api.agent("child"));
  const parent = workflowModule("parent", async (api) => [await api.agent("parent-1"), await api.workflow("child"), await api.agent("parent-2")]);
  const resolveWorkflow = async (ref: WorkflowRef) => {
    if (ref === "child") return child;
    throw new Error(`unexpected workflow ${ref}`);
  };

  await runWithJournal({
    cwd,
    mod: parent,
    writeRunId: "first-run",
    createSession: createLiveTextSession(() => {}),
    resolveWorkflow,
  });
  assert.deepEqual(
    (await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).map((entry) => entry.value),
    ["live:parent-1", "live:child", "live:parent-2"],
  );

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod: parent,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    resolveWorkflow,
  });

  assert.deepEqual(result, ["live:parent-1", "live:child", "live:parent-2"]);
  assert.deepEqual(livePrompts, []);
});

test("runWorkflow reports run metadata and logs the generated run id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-meta-"));
  let metadata: WorkflowRunMetadata | undefined;
  const mod = workflowModule("metadata", async () => "ok");
  await mkdir(join(cwd, ".pi", ".workflow-runs"), { recursive: true });
  await writeFile(workflowJournalPath(cwd, "old-run"), "", "utf8");

  const result = await runWorkflow(fakeContext(cwd), mod, "", {
    runId: "new-run",
    resumeFromRunId: "old-run",
    onRunMetadata(value) {
      metadata = value;
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(metadata, {
    runId: "new-run",
    resumedFromRunId: "old-run",
    journalPath: workflowJournalPath(cwd, "new-run"),
  });
});
