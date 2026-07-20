import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BackgroundWorkflowCoordinator,
  backgroundOrigin,
} from "../.pi/extensions/pi-workflow-engine/src/background-workflows.ts";
import { WorkflowPauseError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { WorkflowProviderUsageLimitError } from "../.pi/extensions/pi-workflow-engine/src/provider-usage-limit.ts";
import { runResolvedWorkflow, runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { WorkflowRunController } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-controller.ts";
import { ProjectWorkflowRunStore, type WorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import type { WorkflowUsageLimitSchedulerClock } from "../.pi/extensions/pi-workflow-engine/src/workflow-usage-limit-scheduler.ts";
import { createTestTheme } from "./fixtures/theme.ts";

interface Notification {
  readonly message: string;
  readonly level: string;
}

class ManualClock implements WorkflowUsageLimitSchedulerClock {
  readonly delays: number[] = [];
  cleared = 0;
  private current = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { readonly due: number; readonly callback: () => void }>();

  now(): number {
    return this.current;
  }

  setNow(now: number): void {
    this.current = now;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.delays.push(delayMs);
    this.timers.set(id, { due: this.current + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === "number" && this.timers.delete(handle)) this.cleared++;
  }

  advance(delayMs: number): void {
    this.current += delayMs;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due > this.current) continue;
      this.timers.delete(id);
      timer.callback();
    }
  }
}

function workflow(): LoadedWorkflow {
  return {
    meta: { name: "history-headless", description: "headless history test" },
    default: async () => ({ summary: "retained headless result" }),
    source: { kind: "fingerprint", fingerprint: "history-headless-source" },
  };
}

function context(
  cwd: string,
  notifications: Notification[],
  mode: ExtensionContext["mode"] = "print",
  branch: unknown[] = [],
): ExtensionCommandContext {
  return {
    cwd,
    mode,
    hasUI: false,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "history-headless-session",
      getBranch: () => branch,
      getEntries: () => branch,
    },
    isIdle: () => true,
    signal: undefined,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
    },
  } as unknown as ExtensionCommandContext;
}

function registeredWorkflow(): LoadedWorkflow {
  return {
    meta: { name: "registered-history", description: "registered lifecycle test" },
    default: async () => ({ summary: "registered lifecycle result" }),
    source: {
      kind: "file",
      path: "/extension/workflows/registered-history.ts",
      root: "/extension",
      fingerprint: "registered-history-source",
    },
  };
}

test("workflow runs command returns useful headless list, details, and action errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-headless-"));
  const notifications: Notification[] = [];
  const ctx = context(cwd, notifications);
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
  });
  try {
    await runWorkflow(ctx as ExtensionContext, workflow(), "", {
      runId: "history-headless-run",
      background: backgroundOrigin(ctx, 1),
    });

    await controller.handleCommand("", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /Recent workflow runs/);
    assert.match(notifications.at(-1)?.message ?? "", /history-headless-run/);
    assert.match(notifications.at(-1)?.message ?? "", /COMPLETED/);

    await controller.handleCommand("inspect history-headless-run", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /retained headless result/);
    assert.match(notifications.at(-1)?.message ?? "", /Find|Outcome/);

    await controller.handleCommand("stop history-headless-run", ctx);
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /not available for completed run/);

    await controller.handleCommand("inspect ..\/invalid", ctx);
    assert.equal(notifications.at(-1)?.level, "warning");
    assert.match(notifications.at(-1)?.message ?? "", /was not found/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow runs command reports empty project history in headless mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-empty-"));
  const notifications: Notification[] = [];
  const ctx = context(cwd, notifications);
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
  });
  try {
    await controller.handleCommand("", ctx);
    assert.equal(
      notifications.at(-1)?.message,
      "No durable workflow runs are available for this project.",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow run completions expose lifecycle actions and retained IDs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-completions-"));
  const notifications: Notification[] = [];
  const ctx = context(cwd, notifications);
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
  });
  try {
    await runWorkflow(ctx as ExtensionContext, workflow(), "", {
      runId: "completion-retained-run",
      background: backgroundOrigin(ctx, 1),
    });
    await controller.sessionStarted(ctx);

    assert.deepEqual(
      (await controller.argumentCompletions("ins"))?.map((item) => item.value),
      ["inspect"],
    );
    assert.deepEqual(
      (await controller.argumentCompletions("inspect completion"))?.map((item) => item.value),
      ["inspect completion-retained-run"],
    );
    assert.ok(
      (await controller.inspectorArgumentCompletions("completion"))
        ?.some((item) => item.value === "completion-retained-run"),
    );
  } finally {
    controller.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow run completions use only the active session context", async () => {
  const notifications: Notification[] = [];
  const queriedCwds: string[] = [];
  const emptyStore: WorkflowRunStore = {
    save: async () => {},
    load: async () => undefined,
    list: async () => [],
    prune: async () => {},
  };
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
    storeForCwd: (cwd) => {
      queriedCwds.push(cwd);
      return emptyStore;
    },
  });
  const ctx = context("/project/current", notifications);

  assert.deepEqual((await controller.argumentCompletions("ins"))?.map((item) => item.value), ["inspect"]);
  assert.equal(await controller.argumentCompletions("inspect "), null);
  assert.deepEqual((await controller.inspectorArgumentCompletions(""))?.map((item) => item.value), ["last"]);
  assert.deepEqual(queriedCwds, [], "completions without an active session must not query a process-scoped store");

  await controller.sessionStarted(ctx);
  queriedCwds.length = 0;
  await controller.inspectorArgumentCompletions("");
  assert.deepEqual(queriedCwds, [ctx.cwd]);

  controller.sessionShutdown(ctx);
  queriedCwds.length = 0;
  assert.equal(await controller.argumentCompletions("inspect "), null);
  assert.deepEqual((await controller.inspectorArgumentCompletions(""))?.map((item) => item.value), ["last"]);
  assert.deepEqual(queriedCwds, []);
});

test("workflow run history uses Pi's native RPC selectors instead of a custom navigator", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-rpc-ui-"));
  const notifications: Notification[] = [];
  const base = context(cwd, notifications, "rpc");
  let customCalls = 0;
  const selections: Array<{ readonly title: string; readonly options: readonly string[] }> = [];
  let selectionStep = 0;
  const ctx = {
    ...base,
    hasUI: true,
    ui: {
      ...base.ui,
      theme: createTestTheme(),
      setStatus() {},
      setWidget() {},
      select: async (title: string, options: string[]) => {
        selections.push({ title, options });
        selectionStep++;
        if (selectionStep === 1) return options.find((option) => option.includes("rpc-selector-run"));
        if (selectionStep === 2) return "inspect";
        return undefined;
      },
      custom: async () => {
        customCalls++;
        throw new Error("RPC must not open custom components");
      },
    },
  } as ExtensionCommandContext;
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
  });
  try {
    await runWorkflow(ctx as ExtensionContext, workflow(), "", {
      runId: "rpc-selector-run",
      background: backgroundOrigin(ctx, 1),
    });
    await controller.handleCommand("", ctx);
    assert.equal(customCalls, 0);
    assert.deepEqual(selections.map((selection) => selection.title), [
      "Workflow Runs",
      "history-headless · rpc-selector-run",
      "Workflow Runs",
    ]);
    assert.match(notifications.at(-1)?.message ?? "", /Workflow run rpc-selector-run/);
    assert.match(notifications.at(-1)?.message ?? "", /retained headless result/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workflow runs command resumes paused runs and restarts terminal runs with new durable IDs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-lifecycle-"));
  const notifications: Notification[] = [];
  const branch: unknown[] = [];
  const ctx = context(cwd, notifications, "rpc", branch);
  const sent: unknown[] = [];
  const background = new BackgroundWorkflowCoordinator({
    sendMessage(message) {
      sent.push(message);
      branch.push({ type: "message", message: { role: "custom", ...message } });
    },
  } as Pick<ExtensionAPI, "sendMessage">);
  const mod = registeredWorkflow();
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async (name) => name === mod.meta.name ? mod : undefined,
    execute: async (backgroundCtx, _name, workflowToRun, options) => {
      await runResolvedWorkflow(backgroundCtx, workflowToRun, "", options);
    },
  });
  const store = new ProjectWorkflowRunStore(cwd);
  try {
    await runWorkflow(ctx as ExtensionContext, mod, "", {
      runId: "restart-source-run",
      background: backgroundOrigin(ctx, 1),
    });
    const pausedSignal = new AbortController();
    pausedSignal.abort(new WorkflowPauseError("paused for lifecycle test"));
    await assert.rejects(runWorkflow(ctx as ExtensionContext, mod, "", {
      runId: "resume-source-run",
      background: backgroundOrigin(ctx, 2),
      signal: pausedSignal.signal,
    }));
    assert.equal((await store.load("resume-source-run"))?.state, "paused");

    await controller.handleCommand("restart restart-source-run", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /Background workflow/);
    await waitFor(async () => {
      const records = await store.list();
      return records.some((record) =>
        record.runId !== "restart-source-run"
        && record.runId !== "resume-source-run"
        && record.options.resumeFromRunId === undefined
        && record.state === "completed"
      );
    });

    await controller.handleCommand("resume resume-source-run", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /Background workflow/);
    await waitFor(async () => {
      const records = await store.list();
      return records.some((record) =>
        record.options.resumeFromRunId === "resume-source-run"
        && record.state === "completed"
        && record.background?.delivery.state === "delivered"
      );
    });
    assert.ok(sent.length >= 2);
  } finally {
    await background.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("provider-limit timers resume from the journal and manual stop cancels pending work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-provider-limit-"));
  const notifications: Notification[] = [];
  const branch: unknown[] = [];
  const ctx = context(cwd, notifications, "rpc", branch);
  const clock = new ManualClock();
  const background = new BackgroundWorkflowCoordinator({
    sendMessage(message) {
      branch.push({ type: "message", message: { role: "custom", ...message } });
    },
  } as Pick<ExtensionAPI, "sendMessage">);
  const resumable = registeredWorkflow();
  const limited: LoadedWorkflow = {
    ...resumable,
    default: async () => {
      throw new WorkflowProviderUsageLimitError({
        stopReason: "error",
        providerMessage: "HTTP 429 Too Many Requests; retry-after: 60",
        provider: "openai",
        resetAt: Date.now() + 60_000,
      });
    },
  };
  const controller = new WorkflowRunController(background, {
    schedulerClock: clock,
    resolveWorkflow: async (name) => name === resumable.meta.name ? resumable : undefined,
    execute: async (backgroundCtx, _name, workflowToRun, options) => {
      await runResolvedWorkflow(backgroundCtx, workflowToRun, "", options);
    },
  });
  background.onRunSettled((settledCtx, runId) => controller.runSettled(settledCtx, runId));
  const store = new ProjectWorkflowRunStore(cwd);
  try {
    await assert.rejects(runWorkflow(ctx as ExtensionContext, limited, "", {
      runId: "auto-resume-source",
      background: backgroundOrigin(ctx, 1),
      autoResumeOnUsageLimit: true,
      usageLimitMaxAttempts: 3,
    }), WorkflowProviderUsageLimitError);
    const paused = await store.load("auto-resume-source");
    if (paused?.state !== "paused" || !paused.pause) throw new Error("Expected provider-limit pause.");
    clock.setNow(paused.pause.nextEligibleAt - 1_000);
    await controller.sessionStarted(ctx);
    assert.equal(clock.delays.at(-1), 1_000);
    clock.advance(1_000);
    await waitFor(async () => (await store.list()).some((record) =>
      record.options.resumeFromRunId === "auto-resume-source"
      && record.options.usageLimitAttempt === 1
      && record.state === "completed"
    ));

    await assert.rejects(runWorkflow(ctx as ExtensionContext, limited, "", {
      runId: "manual-stop-source",
      background: backgroundOrigin(ctx, 2),
      autoResumeOnUsageLimit: true,
      usageLimitMaxAttempts: 3,
    }), WorkflowProviderUsageLimitError);
    const manual = await store.load("manual-stop-source");
    if (manual?.state !== "paused" || !manual.pause) throw new Error("Expected manual-stop pause.");
    clock.setNow(manual.pause.nextEligibleAt - 2_000);
    await controller.runSettled(ctx, manual.runId);
    await controller.handleCommand("stop manual-stop-source", ctx);
    assert.equal((await store.load("manual-stop-source"))?.state, "stopped");
    assert.ok(clock.cleared >= 1);
  } finally {
    controller.sessionShutdown(ctx);
    await background.sessionShutdown(ctx);
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for workflow lifecycle action.");
}
