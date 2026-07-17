import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import {
  executeWorkflowInvocation,
  type ResolvedWorkflowRunner,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-execution.ts";

const snapshot: WorkflowProgressSnapshot = {
  title: "test",
  startedAt: 0,
  currentPhase: "test",
  phases: [],
  counters: [],
  summary: [],
  lanes: [],
  laneOverflow: [],
  logs: [],
};

test("workflow execution invokes composed lifecycle observers independently", async () => {
  let optionSourceCalls = 0;
  let inputSnapshotCalls = 0;
  const observerFailures: unknown[] = [];
  const options = resolveWorkflowRunOptions({
    onProgressSource() {
      optionSourceCalls++;
    },
    async onProgressSnapshot() {
      throw new Error("option snapshot failed");
    },
  }, {});
  const runResolvedWorkflow: ResolvedWorkflowRunner = async (_ctx, _mod, _args, runOptions) => {
    try {
      await runOptions.onProgressSource?.({ snapshot: () => snapshot });
    } catch (error) {
      observerFailures.push(error);
    }
    try {
      await runOptions.onProgressSnapshot?.(snapshot);
    } catch (error) {
      observerFailures.push(error);
    }
    return "ok";
  };
  const mod: LoadedWorkflow = {
    meta: { name: "observer-test", description: "observer test" },
    default: async () => "ok",
    source: { kind: "fingerprint", fingerprint: "observer-test" },
  };

  const execution = await executeWorkflowInvocation({
    ctx: { cwd: process.cwd() } as ExtensionContext,
    name: mod.meta.name,
    mod,
    args: "",
    options,
    runResolvedWorkflow,
    resolveWorkflow: async () => mod,
    async onProgressSource() {
      throw new Error("input source failed");
    },
    onProgressSnapshot() {
      inputSnapshotCalls++;
    },
  });

  assert.equal(execution.envelope.result, "ok");
  assert.equal(optionSourceCalls, 1);
  assert.equal(inputSnapshotCalls, 1);
  assert.equal(observerFailures.length, 2);
  assert.match(String(observerFailures[0]), /input source failed/);
  assert.match(String(observerFailures[1]), /option snapshot failed/);
});
