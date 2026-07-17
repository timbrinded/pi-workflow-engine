import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ProjectWorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import {
  captureWorkflowExtension,
  type CapturedWorkflowExtension,
} from "./workflow-extension-fixtures.ts";

const BACKGROUND_SCRIPT = `
export const meta = { name: "background-e2e", description: "Durable background end-to-end probe" };
export default async function run({ phase, progress }) {
  phase("Host can continue");
  progress({ type: "summary", key: "e2e", value: "retained while background work waits" });
  await globalThis["__piWorkflowBackgroundE2eGate"];
  return { summary: "Background end-to-end complete." };
}
`;

const FOREGROUND_SCRIPT = `
export const meta = { name: "foreground-e2e", description: "Synchronous compatibility probe" };
export default async function run() { return { summary: "Host continued synchronously." }; }
`;

const STOPPABLE_SCRIPT = `
export const meta = { name: "stoppable-e2e", description: "Background stop probe" };
export default async function run({ phase, signal }) {
  phase("Waiting to stop");
  await Promise.race([
    globalThis["__piWorkflowBackgroundStopGate"],
    new Promise((_, reject) => {
      const stop = () => reject(signal?.reason ?? new Error("stopped"));
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    }),
  ]);
  return { summary: "Stop gate released." };
}
`;

interface E2eHost {
  readonly branch: unknown[];
  readonly notifications: string[];
  idle: boolean;
}

function createE2eContext(cwd: string, host: E2eHost): ExtensionCommandContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "background-e2e-session",
      getBranch: () => host.branch,
      getEntries: () => host.branch,
    },
    isIdle: () => host.idle,
    signal: undefined,
    ui: {
      notify: (message: string) => host.notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
}

function backgroundRunId(result: unknown): string {
  if (!isRecord(result) || !isRecord(result.details) || typeof result.details.runId !== "string") {
    throw new Error("expected a durable background run id");
  }
  return result.details.runId;
}

function deliveryCount(extension: CapturedWorkflowExtension, runId: string): number {
  return extension.sentMessages.filter((message) => JSON.stringify(message).includes(runId)).length;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("durable background workflow journey survives host work, inspection, restart, delivery, and stop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-background-e2e-"));
  const host: E2eHost = { branch: [], notifications: [], idle: false };
  const ctx = createE2eContext(cwd, host);
  const runtime = globalThis as typeof globalThis & {
    __piWorkflowBackgroundE2eGate?: Promise<void>;
    __piWorkflowBackgroundStopGate?: Promise<void>;
  };
  const firstGate = Promise.withResolvers<void>();
  const stopGate = Promise.withResolvers<void>();
  runtime.__piWorkflowBackgroundE2eGate = firstGate.promise;
  runtime.__piWorkflowBackgroundStopGate = stopGate.promise;
  const extension = captureWorkflowExtension();
  const runs = extension.commands.get("workflow:runs");
  if (!runs) throw new Error("expected /workflow:runs command");
  const store = new ProjectWorkflowRunStore(cwd);
  let firstRunId: string | undefined;
  let stoppedRunId: string | undefined;

  try {
    firstRunId = backgroundRunId(await extension.tool.execute(
      "e2e-background",
      { background: true, script: BACKGROUND_SCRIPT },
      undefined,
      () => {},
      ctx,
    ));
    await waitUntil(async () => {
      const record = await store.load(firstRunId!);
      return record?.state === "running"
        && record.progress.currentPhase === "Host can continue"
        && JSON.stringify(record.progress.summary).includes("retained while background work waits");
    }, "retained background progress");

    const foreground = await extension.tool.execute(
      "e2e-foreground",
      { script: FOREGROUND_SCRIPT },
      undefined,
      () => {},
      ctx,
    );
    assert.match(JSON.stringify(foreground), /Host continued synchronously/);
    assert.equal((await store.load(firstRunId))?.state, "running");

    await runs.handler(`inspect ${firstRunId}`, ctx);
    assert.match(host.notifications.at(-1) ?? "", /Host can continue/);

    host.idle = true;
    firstGate.resolve();
    await waitUntil(async () => (await store.load(firstRunId!))?.state === "completed", "background completion");
    await waitUntil(() => deliveryCount(extension, firstRunId!) === 1, "single completion delivery");

    const restartedRuns = captureWorkflowExtension().commands.get("workflow:runs");
    if (!restartedRuns) throw new Error("expected restarted /workflow:runs command");
    await restartedRuns.handler(`inspect ${firstRunId}`, ctx);
    assert.match(host.notifications.at(-1) ?? "", /Background end-to-end complete/);

    stoppedRunId = backgroundRunId(await extension.tool.execute(
      "e2e-stoppable",
      { background: true, script: STOPPABLE_SCRIPT },
      undefined,
      () => {},
      ctx,
    ));
    await runs.handler(`stop ${stoppedRunId}`, ctx);
    await waitUntil(async () => (await store.load(stoppedRunId!))?.state === "stopped", "background stop");
    assert.match(host.notifications.at(-1) ?? "", /now stopped/);
    await waitUntil(() => deliveryCount(extension, stoppedRunId!) === 1, "single stopped delivery");
    assert.equal(deliveryCount(extension, firstRunId), 1);
    assert.equal(deliveryCount(extension, stoppedRunId), 1);
  } finally {
    host.idle = true;
    firstGate.resolve();
    stopGate.resolve();
    for (const runId of [firstRunId, stoppedRunId]) {
      if (!runId) continue;
      try {
        await waitUntil(async () => {
          const state = (await store.load(runId))?.state;
          return state === "completed" || state === "failed" || state === "stopped" || state === "paused";
        }, `terminal cleanup for ${runId}`);
      } catch {
        // Best-effort cleanup after an earlier assertion failure.
      }
    }
    delete runtime.__piWorkflowBackgroundE2eGate;
    delete runtime.__piWorkflowBackgroundStopGate;
    await rm(cwd, { recursive: true, force: true });
  }
});
