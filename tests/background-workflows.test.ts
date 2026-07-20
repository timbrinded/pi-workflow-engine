import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  BackgroundWorkflowCoordinator,
  backgroundOrigin,
} from "../.pi/extensions/pi-workflow-engine/src/background-workflows.ts";
import { raceWithAbort } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import {
  createWorkflowRunRecord,
  transitionWorkflowRun,
  type WorkflowRunRecord,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import { ProjectWorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import { createTestTheme } from "./fixtures/theme.ts";

interface SessionHarness {
  readonly branch: unknown[];
  readonly activeBranch?: unknown[];
  idle: boolean;
}

interface SentMessage {
  readonly customType: string;
  readonly content: string;
  readonly details?: unknown;
}

function workflow(name: string, run: LoadedWorkflow["default"]): LoadedWorkflow {
  return {
    meta: { name, description: `${name} test workflow` },
    default: run,
    source: { kind: "fingerprint", fingerprint: `source:${name}` },
  };
}

function progress(runId: string): WorkflowProgressSnapshot {
  return {
    runId,
    title: "background test",
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  };
}

function context(cwd: string, sessionId: string, harness: SessionHarness): ExtensionContext {
  return {
    cwd,
    mode: "tui",
    hasUI: false,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
      getBranch: () => harness.activeBranch ?? harness.branch,
      getEntries: () => harness.branch,
    },
    isIdle: () => harness.idle,
    signal: undefined,
  } as unknown as ExtensionContext;
}

function fakePi(harness: SessionHarness, sent: SentMessage[]): Pick<ExtensionAPI, "sendMessage"> {
  return {
    sendMessage(message) {
      sent.push(message as SentMessage);
      harness.branch.push({
        type: "message",
        message: {
          role: "custom",
          customType: message.customType,
          content: message.content,
          display: message.display,
          details: message.details,
        },
      });
    },
  };
}

async function startRun(
  coordinator: BackgroundWorkflowCoordinator,
  ctx: ExtensionContext,
  mod: LoadedWorkflow,
  runId: string,
): Promise<void> {
  await coordinator.start({
    ctx,
    runId,
    name: mod.meta.name,
    async run(signal, onStarted) {
      await runWorkflow(
        { ...ctx, signal },
        mod,
        "",
        {
          runId,
          signal,
          background: backgroundOrigin(ctx, 1),
          onRunMetadata: () => onStarted(),
        },
      );
    },
  });
}

test("background start returns after durable metadata and delivers success once the session is idle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-success-"));
  const harness: SessionHarness = { branch: [], idle: false };
  const sent: SentMessage[] = [];
  const ctx = context(cwd, "session-success", harness);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, sent));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await startRun(coordinator, ctx, workflow("background-success", async () => {
      await gate;
      return { summary: "Background success." };
    }), "background-success-run");

    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-success-run"))?.state, "running");
    assert.equal(sent.length, 0);
    release?.();
    await waitFor(async () => (await new ProjectWorkflowRunStore(cwd).load("background-success-run"))?.state === "completed");
    assert.equal(sent.length, 0);

    harness.idle = true;
    await coordinator.agentSettled(ctx);
    await coordinator.agentSettled(ctx);
    const record = await new ProjectWorkflowRunStore(cwd).load("background-success-run");
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.content ?? "", /Run ID: background-success-run/);
    assert.match(sent[0]?.content ?? "", /Background success/);
    assert.equal(record?.background?.delivery.state, "delivered");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("RPC background activity uses Pi's string widget surface", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-rpc-widget-"));
  const harness: SessionHarness = { branch: [], idle: false };
  const widgets = new Map<string, string[]>();
  const base = context(cwd, "session-rpc-widget", harness);
  const ctx = {
    ...base,
    mode: "rpc",
    hasUI: true,
    ui: {
      theme: createTestTheme(),
      setStatus() {},
      setWidget(key: string, content: string[] | undefined) {
        if (content === undefined) widgets.delete(key);
        else {
          assert.ok(Array.isArray(content));
          widgets.set(key, content);
        }
      },
    },
  } as unknown as ExtensionContext;
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, []));
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await startRun(coordinator, ctx, workflow("background-rpc-widget", async () => {
      await gate;
      return { summary: "done" };
    }), "background-rpc-widget-run");

    assert.match(widgets.get("workflow-background")?.join("\n") ?? "", /background-rpc-widget/);
    release?.();
    await waitFor(async () => (await new ProjectWorkflowRunStore(cwd).load("background-rpc-widget-run"))?.state === "completed");
    assert.equal(widgets.has("workflow-background"), false);
  } finally {
    release?.();
    await coordinator.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("background start rejects a run whose running state was not durably recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-not-running-"));
  const harness: SessionHarness = { branch: [], idle: false };
  const ctx = context(cwd, "session-not-running", harness);
  const store = new ProjectWorkflowRunStore(cwd);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, []));
  const runId = "background-not-running-run";
  try {
    await store.save(createWorkflowRunRecord({
      runId,
      workflow: workflow("background-not-running", async () => undefined),
      options: resolveWorkflowRunOptions({ background: backgroundOrigin(ctx, 1) }),
      progress: progress(runId),
    }));

    let signal: AbortSignal | undefined;
    await assert.rejects(
      coordinator.start({
        ctx,
        runId,
        name: "background-not-running",
        run: async (backgroundSignal, onStarted) => {
          signal = backgroundSignal;
          onStarted();
          await new Promise<void>((resolve) => backgroundSignal.addEventListener("abort", () => resolve(), { once: true }));
        },
      }),
      /did not create a durable run record/,
    );
    assert.equal(signal?.aborted, true);
  } finally {
    await coordinator.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("background failures are delivered without rejecting unrelated host work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-failure-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const sent: SentMessage[] = [];
  const ctx = context(cwd, "session-failure", harness);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, sent));
  try {
    await startRun(coordinator, ctx, workflow("background-failure", async () => {
      throw new Error("expected background failure");
    }), "background-failure-run");
    await waitFor(() => sent.length === 1);

    const record = await new ProjectWorkflowRunStore(cwd).load("background-failure-run");
    assert.equal(record?.state, "failed");
    assert.equal(record?.background?.delivery.state, "delivered");
    assert.match(sent[0]?.content ?? "", /expected background failure/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("an active background run can be stopped without affecting unrelated host work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-stop-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const sent: SentMessage[] = [];
  const ctx = context(cwd, "session-stop", harness);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, sent));
  try {
    await startRun(
      coordinator,
      ctx,
      workflow("background-stop", async (api) =>
        await raceWithAbort(() => new Promise<never>(() => {}), api.signal)),
      "background-stop-run",
    );
    assert.deepEqual([...coordinator.activeRunIds(ctx)], ["background-stop-run"]);

    const stopped = await coordinator.stop(ctx, "background-stop-run");
    assert.equal(stopped.state, "stopped");
    assert.equal(coordinator.activeRunIds(ctx).size, 0);
    await waitFor(async () =>
      (await new ProjectWorkflowRunStore(cwd).load("background-stop-run"))?.background?.delivery.state === "delivered"
    );
    assert.equal(sent.length, 1);
    assert.match(sent[0]?.content ?? "", /State: stopped/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop is bounded for an uncooperative workflow and cannot later become successful", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-forced-stop-"));
  const harness: SessionHarness = { branch: [], idle: false };
  const logs: string[] = [];
  const ctx = context(cwd, "session-forced-stop", harness);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, []), {
    shutdownWaitMs: 1,
    log: (message) => logs.push(message),
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await startRun(
      coordinator,
      ctx,
      workflow("background-forced-stop", async () => {
        await gate;
        return { summary: "must remain stopped" };
      }),
      "background-forced-stop-run",
    );

    const stopped = await coordinator.stop(ctx, "background-forced-stop-run");
    assert.equal(stopped.state, "stopped");
    assert.match(logs.join("\n"), /forced to stopped/);

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-forced-stop-run"))?.state, "stopped");
  } finally {
    release?.();
    await coordinator.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart recovery marks an interrupted run from the same session paused before delivery", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-hard-restart-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const ctx = context(cwd, "session-hard-restart", harness);
  const store = new ProjectWorkflowRunStore(cwd);
  const runId = "background-hard-restart-run";
  const queued = createWorkflowRunRecord({
    runId,
    workflow: workflow("background-hard-restart", async () => undefined),
    options: resolveWorkflowRunOptions({ background: backgroundOrigin(ctx, 1) }),
    progress: progress(runId),
  });
  await store.save(transitionWorkflowRun(queued, { state: "running", progress: progress(runId), at: 2 }));
  const sent: SentMessage[] = [];
  try {
    const recovered = new BackgroundWorkflowCoordinator(fakePi(harness, sent));
    await recovered.sessionStarted(ctx);

    const record = await store.load(runId);
    assert.equal(record?.state, "paused");
    assert.equal(record?.background?.delivery.state, "delivered");
    assert.match(sent[0]?.content ?? "", /host process ended/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session shutdown pauses an active run and restart recovery delivers the interruption once", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-shutdown-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const firstMessages: SentMessage[] = [];
  const ctx = context(cwd, "session-restart", harness);
  const first = new BackgroundWorkflowCoordinator(fakePi(harness, firstMessages));
  try {
    await first.start({
      ctx,
      runId: "background-paused-run",
      name: "background-paused",
      async run(signal, onStarted) {
        await runWorkflow(
          { ...ctx, signal },
          workflow("background-paused", async () => await raceWithAbort(() => new Promise<never>(() => {}), signal)),
          "",
          {
            runId: "background-paused-run",
            signal,
            background: backgroundOrigin(ctx, 1),
            onRunMetadata: () => onStarted(),
          },
        );
      },
    });
    await first.sessionShutdown(ctx);

    const paused = await new ProjectWorkflowRunStore(cwd).load("background-paused-run");
    assert.equal(paused?.state, "paused");
    assert.equal(paused?.background?.delivery.state, "pending");
    assert.equal(firstMessages.length, 0);

    const recoveredMessages: SentMessage[] = [];
    const recovered = new BackgroundWorkflowCoordinator(fakePi(harness, recoveredMessages));
    await recovered.sessionStarted(ctx);
    await recovered.sessionStarted(ctx);
    assert.equal(recoveredMessages.length, 1);
    assert.match(recoveredMessages[0]?.content ?? "", /State: paused/);
    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-paused-run"))?.background?.delivery.state, "delivered");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shutdown forces an uncooperative workflow checkpoint to paused and it cannot later report success", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-forced-pause-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const sent: SentMessage[] = [];
  const logs: string[] = [];
  const ctx = context(cwd, "session-forced-pause", harness);
  const coordinator = new BackgroundWorkflowCoordinator(fakePi(harness, sent), {
    shutdownWaitMs: 1,
    log: (message) => logs.push(message),
  });
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await startRun(coordinator, ctx, workflow("background-uncooperative", async () => {
      await gate;
      return { summary: "must not be completed" };
    }), "background-forced-pause-run");

    await coordinator.sessionShutdown(ctx);
    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-forced-pause-run"))?.state, "paused");
    assert.match(logs.join("\n"), /forced to paused/);

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-forced-pause-run"))?.state, "paused");
    assert.equal(sent.length, 0);
  } finally {
    release?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("restart recovery suppresses a duplicate already present in the originating session", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-duplicate-"));
  const harness: SessionHarness = { branch: [], activeBranch: [], idle: true };
  const ctx = context(cwd, "session-duplicate", harness);
  try {
    await runWorkflow(ctx, workflow("background-duplicate", async () => ({ summary: "done" })), "", {
      runId: "background-duplicate-run",
      background: backgroundOrigin(ctx, 1),
    });
    harness.branch.push({
      type: "message",
      message: {
        role: "custom",
        customType: "workflow-result",
        details: { background: true, runId: "background-duplicate-run" },
      },
    });

    const sent: SentMessage[] = [];
    const recovered = new BackgroundWorkflowCoordinator(fakePi(harness, sent));
    await recovered.sessionStarted(ctx);
    assert.equal(sent.length, 0);
    assert.equal((await new ProjectWorkflowRunStore(cwd).load("background-duplicate-run"))?.background?.delivery.state, "delivered");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("delivery retry uses the session ledger to avoid a duplicate after persistence fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-retry-"));
  const harness: SessionHarness = { branch: [], idle: true };
  const ctx = context(cwd, "session-retry", harness);
  const durableStore = new ProjectWorkflowRunStore(cwd);
  try {
    await runWorkflow(ctx, workflow("background-retry", async () => ({ summary: "retry once" })), "", {
      runId: "background-retry-run",
      background: backgroundOrigin(ctx, 1),
    });

    let rejectDeliverySave = true;
    const flakyStore = {
      save: async (record: WorkflowRunRecord) => {
        if (record.background?.delivery.state === "delivered" && rejectDeliverySave) {
          rejectDeliverySave = false;
          throw new Error("simulated delivery save failure");
        }
        await durableStore.save(record);
      },
      load: (runId: string) => durableStore.load(runId),
      list: () => durableStore.list(),
      prune: (keep?: number) => durableStore.prune(keep),
    };
    const sent: SentMessage[] = [];
    const logs: string[] = [];
    const recovered = new BackgroundWorkflowCoordinator(fakePi(harness, sent), {
      storeForCwd: () => flakyStore,
      log: (message) => logs.push(message),
    });

    await recovered.sessionStarted(ctx);
    assert.equal(sent.length, 1);
    assert.equal((await durableStore.load("background-retry-run"))?.background?.delivery.state, "pending");
    await recovered.agentSettled(ctx);

    assert.equal(sent.length, 1);
    assert.equal((await durableStore.load("background-retry-run"))?.background?.delivery.state, "delivered");
    assert.match(logs.join("\n"), /simulated delivery save failure/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("missing originating sessions leave results in history and record a logged fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-missing-"));
  const originHarness: SessionHarness = { branch: [], idle: true };
  const origin = context(cwd, "missing-session", originHarness);
  try {
    await runWorkflow(origin, workflow("background-missing", async () => ({ summary: "retained" })), "", {
      runId: "background-missing-run",
      background: backgroundOrigin(origin, 1),
    });

    const currentHarness: SessionHarness = { branch: [], idle: true };
    const current = context(cwd, "different-session", currentHarness);
    const sent: SentMessage[] = [];
    const logs: string[] = [];
    const recovered = new BackgroundWorkflowCoordinator(fakePi(currentHarness, sent), {
      sessionAvailability: async () => "missing",
      log: (message) => logs.push(message),
    });
    await recovered.sessionStarted(current);

    const record = await new ProjectWorkflowRunStore(cwd).load("background-missing-run");
    assert.equal(sent.length, 0);
    assert.equal(record?.background?.delivery.state, "unavailable");
    assert.match(logs.join("\n"), /result remains in workflow run history/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for background workflow state.");
}
