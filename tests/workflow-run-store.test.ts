import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { WORKFLOW_RUNS_DIR } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow, WorkflowRunMetadata } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { emptyWorkflowUsageTotals, type WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import {
  captureWorkflowRunResult,
  createWorkflowRunRecord,
  transitionWorkflowRun,
  type WorkflowRunRecord,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import {
  DurableWorkflowRun,
  ProjectWorkflowRunStore,
  workflowRunRecordPath,
  type WorkflowRunStore,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import { WorkflowProviderUsageLimitError } from "../.pi/extensions/pi-workflow-engine/src/provider-usage-limit.ts";

const USAGE: WorkflowUsageSnapshot = {
  agents: [],
  totals: emptyWorkflowUsageTotals(),
  assistantMessages: 0,
};

function workflow(name = "durable-test"): LoadedWorkflow {
  return {
    meta: { name, description: "durable test" },
    default: async () => ({ summary: "done" }),
    source: { kind: "fingerprint", fingerprint: `source:${name}` },
  };
}

function progress(runId: string, overrides: Partial<WorkflowProgressSnapshot> = {}): WorkflowProgressSnapshot {
  return {
    runId,
    title: "durable-test",
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
    ...overrides,
  };
}

function queuedRecord(runId: string): WorkflowRunRecord {
  return createWorkflowRunRecord({
    runId,
    workflow: workflow(),
    options: resolveWorkflowRunOptions({}, {}),
    progress: progress(runId),
  });
}

function completedRecord(runId: string, at = 3): WorkflowRunRecord {
  const running = transitionWorkflowRun(queuedRecord(runId), { state: "running", progress: progress(runId), at: 2 });
  return transitionWorkflowRun(running, {
    state: "completed",
    progress: progress(runId, { doneAt: at }),
    usage: USAGE,
    result: { summary: "done" },
    at,
  });
}

function fakeContext(cwd: string, signal?: AbortSignal): ExtensionContext {
  return {
    hasUI: false,
    cwd,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "workflow-run-store-test",
    },
    signal,
  } as unknown as ExtensionContext;
}

test("workflow run records enforce queued running paused and terminal transitions", () => {
  const queued = queuedRecord("lifecycle");
  const running = transitionWorkflowRun(queued, { state: "running", progress: progress("lifecycle"), at: 2 });
  const paused = transitionWorkflowRun(running, {
    state: "paused",
    progress: progress("lifecycle"),
    message: "provider limit",
    at: 3,
  });
  const resumed = transitionWorkflowRun(paused, { state: "running", progress: progress("lifecycle"), at: 4 });
  const stopped = transitionWorkflowRun(resumed, {
    state: "stopped",
    progress: progress("lifecycle", { doneAt: 5 }),
    usage: USAGE,
    error: new Error("stopped by user"),
    at: 5,
  });

  assert.equal(queued.state, "queued");
  assert.equal(running.state, "running");
  assert.equal(running.startedAt, 2);
  assert.equal(paused.state, "paused");
  assert.equal(paused.message, "provider limit");
  assert.equal(resumed.message, undefined);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.endedAt, 5);
  assert.match(stopped.message ?? "", /stopped by user/);

  const completed = completedRecord("completed");
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.result, { kind: "value", value: { summary: "done" } });

  const failed = transitionWorkflowRun(
    transitionWorkflowRun(queuedRecord("failed"), { state: "running", progress: progress("failed"), at: 2 }),
    { state: "failed", progress: progress("failed", { doneAt: 3 }), usage: USAGE, error: new Error("boom"), at: 3 },
  );
  assert.equal(failed.state, "failed");
  assert.match(failed.message ?? "", /boom/);
  assert.throws(
    () => transitionWorkflowRun(completed, { state: "running", progress: progress("completed") }),
    /completed -> running/,
  );
});

test("run records persist the explicit edited-workflow resume policy", () => {
  const record = createWorkflowRunRecord({
    runId: "edited-resume-policy",
    workflow: workflow(),
    options: resolveWorkflowRunOptions({
      resumeFromRunId: "prior-run",
      resumeEditedWorkflow: true,
    }, {}),
    progress: progress("edited-resume-policy"),
  });
  assert.equal(record.options.resumeFromRunId, "prior-run");
  assert.equal(record.options.resumeEditedWorkflow, true);
});

test("background provider limits persist a bounded resumable pause record", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-provider-pause-"));
  const ctx = fakeContext(cwd);
  const resetAt = Date.now() + 120_000;
  const limited: LoadedWorkflow = {
    ...workflow("provider-pause"),
    source: {
      kind: "file",
      path: "/extension/workflows/provider-pause.ts",
      root: "/extension",
      fingerprint: "provider-pause-source",
    },
    default: async () => {
      throw new WorkflowProviderUsageLimitError({
        stopReason: "error",
        providerMessage: "HTTP 429 Too Many Requests; authorization: SECRET_TOKEN",
        provider: "openai",
        model: "gpt-test",
        api: "openai-responses",
        resetHint: "retry-after: 120",
        resetAt,
      });
    },
  };
  try {
    await assert.rejects(
      runWorkflow(ctx, limited, "", {
        runId: "provider-pause-run",
        background: { sessionId: "workflow-run-store-test", requestedAt: 1 },
        autoResumeOnUsageLimit: true,
        usageLimitMaxAttempts: 3,
        usageLimitMaxDelayMs: 30_000,
      }),
      WorkflowProviderUsageLimitError,
    );

    const record = await new ProjectWorkflowRunStore(cwd).load("provider-pause-run");
    assert.equal(record?.state, "paused");
    if (record?.state !== "paused") throw new Error("Expected provider pause record.");
    assert.equal(record.pause?.kind, "provider_usage_limit");
    assert.equal(record.pause?.reason, "provider_usage_limit");
    assert.equal(record.pause?.provider, "openai");
    assert.equal(record.pause?.attempt, 1);
    assert.equal(record.pause?.maxAttempts, 3);
    assert.equal(record.pause?.autoResume, true);
    assert.ok((record.pause?.nextEligibleAt ?? 0) <= Date.now() + 30_000);
    assert.ok((record.pause?.nextEligibleAt ?? 0) >= Date.now() + 29_000);
    assert.doesNotMatch(record.pause?.providerMessage ?? "", /SECRET_TOKEN/);
    assert.equal(record.options.usageLimitAttempt, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider-limit auto resume stays disabled when invocation arguments are not persisted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-provider-args-"));
  const ctx = fakeContext(cwd);
  const limited: LoadedWorkflow = {
    ...workflow("provider-args"),
    source: {
      kind: "file",
      path: "/extension/workflows/provider-args.ts",
      root: "/extension",
      fingerprint: "provider-args-source",
    },
    default: async () => {
      throw new WorkflowProviderUsageLimitError({
        stopReason: "error",
        providerMessage: "rate_limit_error",
      });
    },
  };
  try {
    await assert.rejects(runWorkflow(ctx, limited, "private invocation args", {
      runId: "provider-args-run",
      background: { sessionId: "workflow-run-store-test", requestedAt: 1 },
      autoResumeOnUsageLimit: true,
    }), WorkflowProviderUsageLimitError);
    const record = await new ProjectWorkflowRunStore(cwd).load("provider-args-run");
    assert.equal(record?.state, "paused");
    if (record?.state !== "paused") throw new Error("Expected provider pause record.");
    assert.equal(record.options.argumentsPresent, true);
    assert.equal(record.pause?.autoResume, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project run store atomically reloads records and isolates corrupt or future files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-store-"));
  try {
    const store = new ProjectWorkflowRunStore(cwd);
    await store.save(completedRecord("kept"));
    const reloaded = await new ProjectWorkflowRunStore(cwd).load("kept");
    assert.equal(reloaded?.state, "completed");
    assert.equal(reloaded?.runId, "kept");
    assert.equal((await stat(workflowRunRecordPath(cwd, "kept"))).mode & 0o777, 0o600);

    const futureFields = { ...completedRecord("future-fields"), futureField: { nested: true } };
    await writeFile(workflowRunRecordPath(cwd, "future-fields"), `${JSON.stringify(futureFields)}\n`, "utf8");
    await writeFile(workflowRunRecordPath(cwd, "corrupt"), "{broken\n", "utf8");
    await writeFile(
      workflowRunRecordPath(cwd, "future-version"),
      `${JSON.stringify({ ...completedRecord("future-version"), version: 2 })}\n`,
      "utf8",
    );
    await writeFile(
      workflowRunRecordPath(cwd, "wrong-path"),
      `${JSON.stringify(completedRecord("different-id"))}\n`,
      "utf8",
    );
    await writeFile(
      workflowRunRecordPath(cwd, "invalid-state-fields"),
      `${JSON.stringify({ ...queuedRecord("invalid-state-fields"), message: "not valid while queued" })}\n`,
      "utf8",
    );
    await writeFile(`${workflowRunRecordPath(cwd, "interrupted")}.partial.tmp`, "partial", "utf8");

    assert.equal((await store.load("future-fields"))?.state, "completed");
    assert.equal(await store.load("corrupt"), undefined);
    assert.equal(await store.load("future-version"), undefined);
    assert.equal(await store.load("wrong-path"), undefined);
    assert.equal(await store.load("invalid-state-fields"), undefined);
    assert.deepEqual((await store.list()).map((record) => record.runId), ["future-fields", "kept"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persisted run records exclude raw prompts transcripts logs details and credentials", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-privacy-"));
  try {
    const runId = "privacy";
    const sensitiveProgress = progress(runId, {
      phases: [{
        title: "Find",
        agents: [{ id: 1, label: "finder", status: "failed", toolUses: 1, error: "SECRET_AGENT_ERROR" }],
      }],
      lanes: [["Findings", [{
        lane: "Findings",
        title: "Visible finding",
        status: "warning",
        details: "SECRET_TOOL_OUTPUT",
        createdAt: 2,
      }]]],
      logs: ["SECRET_PROMPT_TEXT"],
    });
    const queued = createWorkflowRunRecord({
      runId,
      workflow: workflow(),
      options: resolveWorkflowRunOptions({
        onUsageSnapshot() {
          throw new Error("must never be serialized");
        },
      }, {}),
      progress: sensitiveProgress,
    });
    const completed = transitionWorkflowRun(
      transitionWorkflowRun(queued, { state: "running", progress: sensitiveProgress, at: 2 }),
      {
        state: "completed",
        progress: { ...sensitiveProgress, doneAt: 3 },
        usage: USAGE,
        result: {
          summary: "Visible result",
          prompt: "SECRET_RESULT_PROMPT",
          messages: ["SECRET_TRANSCRIPT"],
          nested: { apiKey: "SECRET_API_KEY", environment: { TOKEN: "SECRET_ENV" } },
        },
        at: 3,
      },
    );
    const store = new ProjectWorkflowRunStore(cwd);
    await store.save(completed);

    const content = await readFile(workflowRunRecordPath(cwd, runId), "utf8");
    assert.match(content, /Visible result/);
    assert.match(content, /Visible finding/);
    assert.doesNotMatch(content, /SECRET_/);
    assert.doesNotMatch(content, /onUsageSnapshot/);
    assert.deepEqual(completed.progress.logs, []);
    assert.equal(completed.progress.lanes[0]?.[1][0]?.details, undefined);
    assert.equal(completed.progress.phases[0]?.agents[0]?.error, undefined);

    const credentialFailure = transitionWorkflowRun(
      transitionWorkflowRun(queuedRecord("credential-failure"), {
        state: "running",
        progress: progress("credential-failure"),
        at: 2,
      }),
      {
        state: "failed",
        progress: progress("credential-failure", { doneAt: 3 }),
        usage: USAGE,
        error: new Error("authorization: Bearer SECRET_CREDENTIAL sk-proj-abcdefgh12345678"),
        at: 3,
      },
    );
    assert.doesNotMatch(credentialFailure.message ?? "", /SECRET_CREDENTIAL|sk-proj/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("result capture is bounded and never executes accessors", () => {
  let accessed = false;
  const value = Object.defineProperty({ summary: "ok" }, "computed", {
    enumerable: true,
    get() {
      accessed = true;
      return "secret";
    },
  });
  assert.deepEqual(captureWorkflowRunResult(value), {
    kind: "value",
    value: { summary: "ok", computed: "[redacted]" },
  });
  assert.equal(accessed, false);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual(captureWorkflowRunResult(cyclic), {
    kind: "unavailable",
    reason: "result contains a cycle",
  });

  const sparse = new Array(20_000);
  assert.deepEqual(captureWorkflowRunResult(sparse), {
    kind: "unavailable",
    reason: "result exceeded 16384 values",
  });
});

test("run record snapshots cap repeated progress and usage collections", () => {
  const runId = "bounded-snapshot";
  const counters = Array.from({ length: 205 }, (_value, index) => ({
    key: `counter-${index}`,
    label: `Counter ${index}`,
    value: index,
  }));
  const usage: WorkflowUsageSnapshot = {
    agents: Array.from({ length: 1_005 }, (_value, index) => ({
      label: `agent-${index}`,
      assistantMessages: 1,
      usage: emptyWorkflowUsageTotals(),
    })),
    totals: emptyWorkflowUsageTotals(),
    assistantMessages: 1_005,
  };
  const record = createWorkflowRunRecord({
    runId,
    workflow: workflow(),
    options: resolveWorkflowRunOptions({}, {}),
    progress: progress(runId, {
      phases: Array.from({ length: 205 }, (_value, index) => ({ title: `phase-${index}`, agents: [] })),
      counters,
      summary: counters.map((counter) => [counter.key, counter.value]),
      lanes: Array.from({ length: 55 }, (_value, laneIndex) => [
        `lane-${laneIndex}`,
        Array.from({ length: 205 }, (_item, itemIndex) => ({
          lane: `lane-${laneIndex}`,
          title: `item-${itemIndex}`,
          status: "pending" as const,
          createdAt: itemIndex,
        })),
      ]),
      laneOverflow: Array.from({ length: 55 }, (_value, index) => [`lane-${index}`, index]),
      usage,
    }),
  });

  assert.equal(record.progress.phases.length, 200);
  assert.equal(record.progress.counters.length, 200);
  assert.equal(record.progress.summary.length, 200);
  assert.equal(record.progress.lanes.length, 50);
  assert.equal(record.progress.lanes[0]?.[1].length, 200);
  assert.equal(record.progress.laneOverflow.length, 50);
  assert.equal(record.progress.usage?.agents.length, 1_000);
  assert.equal(record.progress.usage?.agents[0]?.label, "agent-5");
});

test("durable writer coalesces progress while preserving the terminal record", async () => {
  let releaseFirstSave: (() => void) | undefined;
  const firstSave = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  const saved: WorkflowRunRecord[] = [];
  let saves = 0;
  const store: WorkflowRunStore = {
    async save(record) {
      saves++;
      if (saves === 1) await firstSave;
      saved.push(record);
    },
    async load() {
      return undefined;
    },
    async list() {
      return [];
    },
    async prune() {},
  };
  const durable = new DurableWorkflowRun(store, queuedRecord("coalesced"));
  durable.transition({ state: "running", progress: progress("coalesced"), at: 2 });
  durable.updateProgress(progress("coalesced", { currentPhase: "Find" }), 3);
  durable.transition({
    state: "completed",
    progress: progress("coalesced", { currentPhase: "Done", doneAt: 4 }),
    usage: USAGE,
    result: "done",
    at: 4,
  });
  releaseFirstSave?.();
  await durable.flush();

  assert.equal(saved[0]?.state, "queued");
  assert.equal(saved.at(-1)?.state, "completed");
  assert.equal(saved.at(-1)?.progress.currentPhase, "Done");
  assert.ok(saved.length < 4);
});

test("run record retention keeps only the newest configured records", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-prune-"));
  try {
    const store = new ProjectWorkflowRunStore(cwd);
    await store.save(completedRecord("old", 2));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save(completedRecord("middle", 3));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.save(completedRecord("new", 4));

    await store.prune(1);
    assert.deepEqual((await store.list()).map((record) => record.runId), ["new"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow persists one stable identity across metadata progress journal and result", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-integration-"));
  try {
    let metadata: WorkflowRunMetadata | undefined;
    let finalProgress: WorkflowProgressSnapshot | undefined;
    const mod = workflow("integrated");
    const result = await runWorkflow(fakeContext(cwd), mod, "SECRET_RAW_ARGS", {
      runId: "integrated-run",
      concurrency: 3,
      onRunMetadata(value) {
        metadata = value;
      },
      onProgressSnapshot(value) {
        finalProgress = value;
      },
    });
    const record = await new ProjectWorkflowRunStore(cwd).load("integrated-run");
    const content = await readFile(workflowRunRecordPath(cwd, "integrated-run"), "utf8");

    assert.deepEqual(result, { summary: "done" });
    assert.equal(metadata?.runId, "integrated-run");
    assert.equal(finalProgress?.runId, "integrated-run");
    assert.equal(record?.runId, "integrated-run");
    assert.equal(record?.journalFile, "integrated-run.jsonl");
    assert.equal(record?.state, "completed");
    assert.equal(record?.options.concurrency, 3);
    assert.equal(record?.options.argumentsPresent, true);
    assert.deepEqual(record?.result, { kind: "value", value: { summary: "done" } });
    assert.doesNotMatch(content, /SECRET_RAW_ARGS/);
    assert.equal(metadata?.recordPath, workflowRunRecordPath(cwd, "integrated-run"));
    assert.equal((await stat(metadata?.journalPath ?? "")).isFile(), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow persists failed outcomes without a stack or transcript", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-failed-"));
  try {
    const mod: LoadedWorkflow = {
      ...workflow("failed-integration"),
      default: async () => {
        throw new Error("expected failure");
      },
    };
    await assert.rejects(() => runWorkflow(fakeContext(cwd), mod, "", { runId: "failed-run" }), /expected failure/);
    const record = await new ProjectWorkflowRunStore(cwd).load("failed-run");

    assert.equal(record?.state, "failed");
    assert.equal(record?.result, undefined);
    assert.equal(record?.message, "expected failure");
    assert.equal(typeof record?.endedAt, "number");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runWorkflow persists an undefined rejection as a failed outcome", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-undefined-failure-"));
  try {
    const mod: LoadedWorkflow = {
      ...workflow("undefined-failure"),
      default: async () => await Promise.reject(undefined),
    };
    let rejected = false;
    try {
      await runWorkflow(fakeContext(cwd), mod, "", { runId: "undefined-failure-run" });
    } catch (error) {
      rejected = true;
      assert.equal(error, undefined);
    }
    const record = await new ProjectWorkflowRunStore(cwd).load("undefined-failure-run");

    assert.equal(rejected, true);
    assert.equal(record?.state, "failed");
    assert.equal(record?.message, "undefined");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
