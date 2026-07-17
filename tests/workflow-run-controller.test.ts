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
import { runResolvedWorkflow, runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { WorkflowRunController } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-controller.ts";
import { ProjectWorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";

interface Notification {
  readonly message: string;
  readonly level: string;
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

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for workflow lifecycle action.");
}
