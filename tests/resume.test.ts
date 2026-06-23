import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow, runWorkflowWithContext, type WorkflowContextOptions, type WorkflowProgress } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import type { AgentProgress, CreateAgentSession, RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import {
  createAgentIndexCounter,
  createWorkflowJournal,
  loadJournalEntries,
  workflowJournalPath,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { NoopPerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { WorkflowModule, WorkflowProgressEvent, WorkflowRef, WorkflowRunMetadata } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

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
    nextAgentIndex: createAgentIndexCounter(),
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

test("resume invalidates the suffix after the first changed agent call", async () => {
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
  assert.deepEqual(livePrompts, ["changed", "c"]);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "second-run"))).length, 3);
});

test("sub-workflow agents share the same resume index space", async () => {
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
