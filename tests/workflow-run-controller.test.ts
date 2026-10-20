import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  BackgroundWorkflowCoordinator,
  backgroundOrigin,
} from "../.pi/extensions/pi-workflow-engine/src/background-workflows.ts";
import { WorkflowPauseError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { WorkflowProviderUsageLimitError } from "../.pi/extensions/pi-workflow-engine/src/provider-usage-limit.ts";
import { runResolvedWorkflow, runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { emptyWorkflowUsageTotals } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { WorkflowRunController } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-controller.ts";
import {
  createWorkflowRunRecord,
  transitionWorkflowRun,
  type WorkflowRunRecord,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import {
  ProjectWorkflowRunStore,
  workflowRunScriptPath,
  type WorkflowRunStore,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import { sealWorkflowRunScript } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-seal.ts";
import { compileInlineWorkflow } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { WorkflowRunsBrowser } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-runs-browser.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-viewer-layout.ts";
import { WORKFLOW_INSPECTOR_OVERLAY_OPTIONS } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-inspector.ts";
import type { WorkflowUsageLimitSchedulerClock } from "../.pi/extensions/pi-workflow-engine/src/workflow-usage-limit-scheduler.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

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
      "history-headless (inline) · rpc-selector-run",
      "Workflow Runs",
    ]);
    assert.match(notifications.at(-1)?.message ?? "", /Workflow run rpc-selector-run/);
    assert.match(notifications.at(-1)?.message ?? "", /retained headless result/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("TUI workflow runs open the runs browser and return to it on the same run after inspecting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-tui-"));
  const notifications: Notification[] = [];
  const base = context(cwd, notifications, "tui");
  const opened: string[] = [];
  const cursorRows: string[] = [];
  const ctx = {
    ...base,
    hasUI: true,
    ui: {
      ...base.ui,
      theme: createTestTheme(),
      setStatus() {},
      setWidget() {},
      select: async () => {
        throw new Error("the TUI must not fall back to native selects");
      },
      custom: async <T>(
        factory: (tui: TUI, theme: Theme, keybindings: never, done: (value: T) => void) => Component,
        options?: unknown,
      ): Promise<T> => {
        let result: T | undefined;
        const tui = { requestRender() {}, terminal: { rows: 40, columns: 120 } } as unknown as TUI;
        const component = factory(tui, createTestTheme(), undefined as never, (value) => {
          result = value;
        });
        if (component instanceof WorkflowRunsBrowser) {
          assert.deepEqual(options, WORKFLOW_VIEWER_OVERLAY_OPTIONS);
          opened.push("browser");
          const first = opened.length === 1;
          if (first) component.handleInput("\u001b[B");
          cursorRows.push(component.render(100).map(plain).find((line) => line.startsWith("│ ›")) ?? "");
          component.handleInput(first ? "\r" : "q");
        } else {
          assert.deepEqual(options, WORKFLOW_INSPECTOR_OVERLAY_OPTIONS);
          opened.push("inspector");
          component.handleInput?.("q");
        }
        return result as T;
      },
    },
  } as unknown as ExtensionCommandContext;
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async () => {},
  });
  try {
    await runWorkflow(ctx as ExtensionContext, workflow(), "", { runId: "tui-older-run", background: backgroundOrigin(ctx, 1) });
    await runWorkflow(ctx as ExtensionContext, workflow(), "", { runId: "tui-browser-run", background: backgroundOrigin(ctx, 2) });

    await controller.handleCommand("", ctx);

    assert.deepEqual(opened, ["browser", "inspector", "browser"]);
    assert.equal(cursorRows.length, 2);
    assert.match(cursorRows[0] ?? "", /tui-(brow|olde)/);
    assert.equal(cursorRows[1], cursorRows[0], "the browser reopens on the inspected (second) run");
    assert.deepEqual(notifications, []);
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

test("inline runs restart and resume from their sealed script, only while it is retained and unchanged", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-inline-"));
  const restoreAgentDir = await useTemporaryAgentDir();
  const notifications: Notification[] = [];
  const branch: unknown[] = [];
  const ctx = context(cwd, notifications, "rpc", branch);
  const background = new BackgroundWorkflowCoordinator({
    sendMessage(message) {
      branch.push({ type: "message", message: { role: "custom", ...message } });
    },
  } as Pick<ExtensionAPI, "sendMessage">);
  const relaunched: LoadedWorkflow[] = [];
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async (backgroundCtx, _name, workflowToRun, options) => {
      relaunched.push(workflowToRun);
      await runResolvedWorkflow(backgroundCtx, workflowToRun, "", options);
    },
  });
  const store = new ProjectWorkflowRunStore(cwd);
  const inline = compileInlineWorkflow('export const meta = { name: "inline-lifecycle", description: "" };\nexport default async function run() { return { summary: "inline lifecycle result" }; }\n');
  try {
    await runWorkflow(ctx as ExtensionContext, inline, "", { runId: "inline-restart-source", background: backgroundOrigin(ctx, 1) });
    const pausedSignal = new AbortController();
    pausedSignal.abort(new WorkflowPauseError("paused for inline lifecycle test"));
    await assert.rejects(runWorkflow(ctx as ExtensionContext, inline, "", {
      runId: "inline-resume-source",
      background: backgroundOrigin(ctx, 2),
      signal: pausedSignal.signal,
    }));

    await controller.handleCommand("restart inline-restart-source", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /Background workflow "inline-lifecycle" started[\s\S]*\nScript: /);
    await controller.handleCommand("resume inline-resume-source", ctx);
    await waitFor(async () => (await store.list()).filter((record) => record.state === "completed").length === 3);
    assert.equal(relaunched.length, 2);
    assert.ok(relaunched.every((workflowToRun) => workflowToRun.inlineScript === inline.inlineScript));

    // An in-place edit leaves the seal covering the recorded script only.
    await assert.rejects(runWorkflow(ctx as ExtensionContext, inline, "", {
      runId: "inline-edited-source",
      background: backgroundOrigin(ctx, 3),
      signal: pausedSignal.signal,
    }));
    await writeFile(workflowRunScriptPath(cwd, "inline-restart-source"), `${inline.inlineScript}// edited\n`);
    await writeFile(workflowRunScriptPath(cwd, "inline-edited-source"), `${inline.inlineScript}// edited\n`);
    for (const command of ["restart inline-restart-source", "resume inline-edited-source"]) {
      await controller.handleCommand(command, ctx);
      assert.equal(notifications.at(-1)?.level, "error");
      assert.match(
        notifications.at(-1)?.message ?? "",
        /was not recorded by this pi install, or its script changed since; rerun it with the workflow tool's scriptPath \(\.pi\/\.workflow-runs\/inline-(restart|edited)-source\.script\.js\)/,
      );
    }
    assert.equal(relaunched.length, 2);

    await rm(workflowRunScriptPath(cwd, "inline-restart-source"));
    await controller.handleCommand("restart inline-restart-source", ctx);
    assert.equal(notifications.at(-1)?.level, "error");
    assert.match(notifications.at(-1)?.message ?? "", /inline workflow script inline-restart-source\.script\.js is unavailable/);
  } finally {
    await background.sessionShutdown(ctx);
    await restoreAgentDir();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a repository's own inline run record and script never relaunch, however it is named or sealed", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runs-forged-"));
  const restoreAgentDir = await useTemporaryAgentDir();
  const notifications: Notification[] = [];
  const ctx = context(cwd, notifications, "rpc");
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const relaunched: string[] = [];
  const controller = new WorkflowRunController(background, {
    resolveWorkflow: async () => undefined,
    execute: async (_ctx, name) => {
      relaunched.push(name);
    },
  });
  const store = new ProjectWorkflowRunStore(cwd);
  const script = 'export const meta = { name: "code-review", description: "" };\nexport default async function run() { return { summary: "forged" }; }\n';
  const attackerAgentDir = await mkdtemp(join(tmpdir(), "pi-workflow-runs-attacker-agent-"));
  try {
    // This install has a key, and the repository seals with a key of its own.
    await sealWorkflowRunScript("genuine-run", "genuine-source");
    const forged = compileInlineWorkflow(script);
    if (forged.source.kind !== "fingerprint") throw new Error("expected an inline fingerprint");
    const fingerprint = forged.source.fingerprint;
    const attackerSeal = (runId: string) => sealWorkflowRunScript(runId, fingerprint, attackerAgentDir);
    const runs = [
      { runId: "forged-unsealed", state: "completed" as const, scriptSeal: undefined },
      { runId: "forged-unsealed-paused", state: "paused" as const, scriptSeal: undefined },
      { runId: "forged-sealed", state: "completed" as const, scriptSeal: await attackerSeal("forged-sealed") },
      { runId: "forged-sealed-paused", state: "paused" as const, scriptSeal: await attackerSeal("forged-sealed-paused") },
    ];
    for (const run of runs) {
      await store.save(inlineRunRecord(run.runId, forged, run.state, run.scriptSeal));
      await writeFile(workflowRunScriptPath(cwd, run.runId), script);
    }

    await controller.handleCommand("", ctx);
    const listing = notifications.at(-1)?.message ?? "";
    assert.match(listing, /COMPLETED code-review \(inline\) · .* · forged-unsealed$/m, "an unsealed record offers no restart");
    assert.match(listing, /PAUSED code-review \(inline\) · .* · forged-unsealed-paused · actions stop$/m, "or resume");

    await controller.handleCommand("restart forged-unsealed", ctx);
    assert.equal(notifications.at(-1)?.message, "Action restart is not available for completed run forged-unsealed.");
    await controller.handleCommand("resume forged-unsealed-paused", ctx);
    assert.equal(notifications.at(-1)?.message, "Action resume is not available for paused run forged-unsealed-paused.");
    for (const command of ["restart forged-sealed", "resume forged-sealed-paused"]) {
      await controller.handleCommand(command, ctx);
      assert.equal(notifications.at(-1)?.level, "error");
      assert.match(notifications.at(-1)?.message ?? "", /inline run forged-sealed(-paused)? was not recorded by this pi install/);
    }
    assert.deepEqual(relaunched, []);
  } finally {
    await background.sessionShutdown(ctx);
    await restoreAgentDir();
    await rm(attackerAgentDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

/** An inline run's record as the engine would write it, with whatever seal the caller claims. */
function inlineRunRecord(
  runId: string,
  workflowToRecord: LoadedWorkflow,
  state: "completed" | "paused",
  scriptSeal: string | undefined,
): WorkflowRunRecord {
  const progress: WorkflowProgressSnapshot = {
    runId,
    title: workflowToRecord.meta.name,
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  };
  const running = transitionWorkflowRun(
    createWorkflowRunRecord({
      runId,
      workflow: workflowToRecord,
      options: resolveWorkflowRunOptions({}, {}),
      progress,
      scriptPersisted: true,
      scriptSeal,
    }),
    { state: "running", progress, at: 2 },
  );
  return state === "paused"
    ? transitionWorkflowRun(running, { state: "paused", progress, message: "paused", at: 3 })
    : transitionWorkflowRun(running, {
      state: "completed",
      progress,
      usage: { agents: [], totals: emptyWorkflowUsageTotals(), assistantMessages: 0 },
      result: { summary: "done" },
      at: 3,
    });
}

/** Point pi's agent directory, and so the run seal key, at a fresh directory until the returned restore runs. */
async function useTemporaryAgentDir(): Promise<() => Promise<void>> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-workflow-runs-agent-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(agentDir, { recursive: true, force: true });
  };
}

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
      // Started under Dynamax: its successor must wake the agent too.
      background: backgroundOrigin(ctx, 1, true),
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
    const successor = (await store.list()).find((record) => record.options.resumeFromRunId === "auto-resume-source");
    assert.equal(successor?.background?.origin.wakeOnComplete, true);
    // The source stays paused after its resume; re-entering the session must not resume it again.
    const scheduledBeforeReentry = clock.delays.length;
    controller.sessionShutdown(ctx);
    await controller.sessionStarted(ctx);
    assert.equal(clock.delays.length, scheduledBeforeReentry);

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

test("a paused run offers no second resume while its resume is live, and again once that resume failed", async () => {
  const notifications: Notification[] = [];
  const ctx = context("/project/superseded", notifications, "rpc");
  const clock = new ManualClock();
  const records = new Map<string, WorkflowRunRecord>();
  const store: WorkflowRunStore = {
    save: async (record) => {
      records.set(record.runId, record);
    },
    load: async (runId) => records.get(runId),
    list: async () => [...records.values()],
    prune: async () => {},
  };
  const relaunched: string[] = [];
  const background = new BackgroundWorkflowCoordinator({ sendMessage() {} } as Pick<ExtensionAPI, "sendMessage">);
  const controller = new WorkflowRunController(background, {
    schedulerClock: clock,
    storeForCwd: () => store,
    resolveWorkflow: async (name) => {
      relaunched.push(name);
      return undefined;
    },
    execute: async () => {},
  });
  const progress = (runId: string): WorkflowProgressSnapshot => ({
    runId,
    title: "registered-history",
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  });
  const runningRecord = (runId: string, resumeFromRunId?: string): WorkflowRunRecord => transitionWorkflowRun(
    createWorkflowRunRecord({
      runId,
      workflow: registeredWorkflow(),
      options: resolveWorkflowRunOptions({
        background: { sessionId: "history-headless-session", requestedAt: 1 },
        autoResumeOnUsageLimit: true,
        resumeFromRunId,
      }, {}),
      progress: progress(runId),
    }),
    { state: "running", progress: progress(runId), at: 2 },
  );
  const source = transitionWorkflowRun(runningRecord("superseded-source"), {
    state: "paused",
    progress: progress("superseded-source"),
    message: "provider usage limit",
    pause: {
      kind: "provider_usage_limit",
      reason: "provider_usage_limit",
      providerMessage: "rate limit",
      attempt: 1,
      nextEligibleAt: 60_000,
      autoResume: true,
      maxAttempts: 3,
    },
    at: 3,
  });
  const resume = runningRecord("superseded-resume", source.runId);
  records.set(source.runId, source);
  records.set(resume.runId, resume);
  try {
    await controller.sessionStarted(ctx);

    await controller.handleCommand("", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /superseded-source · resumed as superseded-resume · actions stop$/m);
    assert.equal(await controller.argumentCompletions("resume "), null);
    await controller.handleCommand("resume superseded-source", ctx);
    assert.equal(notifications.at(-1)?.message, "Workflow run superseded-source was already resumed as superseded-resume.");
    assert.deepEqual(relaunched, []);

    records.set(resume.runId, transitionWorkflowRun(resume, {
      state: "failed",
      progress: progress(resume.runId),
      usage: { agents: [], totals: emptyWorkflowUsageTotals(), assistantMessages: 0 },
      error: "resume failed",
      at: 4,
    }));
    await controller.handleCommand("", ctx);
    assert.match(notifications.at(-1)?.message ?? "", /superseded-source · actions stop, resume$/m);
    assert.deepEqual(
      (await controller.argumentCompletions("resume "))?.map((item) => item.value),
      ["resume superseded-source"],
    );
    await controller.handleCommand("resume superseded-source", ctx);
    assert.deepEqual(relaunched, ["registered-history"]);

    // Automatic resume stays spent: re-arming after a failed resume would relaunch on every session start.
    controller.sessionShutdown(ctx);
    await controller.sessionStarted(ctx);
    assert.deepEqual(clock.delays, []);
  } finally {
    controller.sessionShutdown(ctx);
  }
});

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for workflow lifecycle action.");
}
