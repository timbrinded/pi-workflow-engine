import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runWorkflow } from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import { getLastWorkflowInspection, sendWorkflowResult } from "../.pi/extensions/pi-workflow-engine";
import type { PerfSnapshot } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressSource } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

function loadedWorkflow(mod: WorkflowModule): LoadedWorkflow {
  return {
    ...mod,
    source: { kind: "fingerprint", fingerprint: `workflow-perf-test:${mod.meta.name}:${mod.default.toString()}` },
  };
}

function fakeContext(signal?: AbortSignal): ExtensionContext {
  return {
    hasUI: false,
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => "workflow-perf-test",
    },
    signal,
  } as unknown as ExtensionContext;
}

function fakeCommandContext(signal?: AbortSignal): ExtensionCommandContext {
  return fakeContext(signal) as unknown as ExtensionCommandContext;
}

function fakePi(): ExtensionAPI {
  return {
    sendMessage() {
      throw new Error("sendMessage should not be called for failing workflows");
    },
  } as unknown as ExtensionAPI;
}

test("runWorkflow exposes a perf snapshot when perf is enabled", async () => {
  let snapshot: PerfSnapshot | undefined;
  const mod: WorkflowModule = {
    meta: { name: "perf-test", description: "perf" },
    default: async () => "ok",
  };

  const result = await runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
    perf: true,
    onPerfSnapshot: (value) => {
      snapshot = value;
    },
  });

  assert.equal(result, "ok");
  assert.equal(snapshot?.enabled, true);
  assert.ok(snapshot?.aggregates.some((aggregate) => aggregate.name === "workflow.total_ms"));
});

test("runWorkflow exposes a usage snapshot even when perf is disabled", async () => {
  let snapshot: WorkflowUsageSnapshot | undefined;
  const mod: WorkflowModule = {
    meta: { name: "usage-snapshot-test", description: "usage snapshot" },
    default: async () => "ok",
  };

  const result = await runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
    onUsageSnapshot: (value) => {
      snapshot = value;
    },
  });

  assert.equal(result, "ok");
  assert.equal(snapshot?.assistantMessages, 0);
  assert.equal(snapshot?.totals.totalTokens, 0);
  assert.deepEqual(snapshot?.agents, []);
});

test("runWorkflow exposes a completed progress snapshot", async () => {
  let snapshot: WorkflowProgressSnapshot | undefined;
  const mod: WorkflowModule = {
    meta: { name: "progress-snapshot-test", description: "progress snapshot" },
    default: async (api) => {
      api.log("captured log entry");
      api.progress({ type: "summary", key: "kept", value: 1 });
      api.progress({ type: "lane_item", lane: "Findings", title: "Captured finding", status: "success", details: "expanded details" });
      return "ok";
    },
  };

  const result = await runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
    onProgressSnapshot: (value) => {
      snapshot = value;
    },
  });

  assert.equal(result, "ok");
  assert.equal(snapshot?.title, "progress-snapshot-test");
  assert.equal(typeof snapshot?.doneAt, "number");
  assert.deepEqual(snapshot?.summary, [["kept", 1]]);
  assert.equal(snapshot?.lanes[0]?.[0], "Findings");
  assert.equal(snapshot?.lanes[0]?.[1][0]?.details, "expanded details");
  assert.ok(snapshot?.logs.includes("captured log entry"));
});

test("sendWorkflowResult retains failed workflow progress snapshots for later inspection", async () => {
  const mod: WorkflowModule = {
    meta: { name: "failing-snapshot-test", description: "failed snapshot" },
    default: async (api) => {
      api.log("failing workflow log");
      api.progress({ type: "lane_item", lane: "Failures", title: "Failure finding", status: "error", details: "boom details" });
      throw new Error("boom");
    },
  };

  await assert.rejects(() => sendWorkflowResult(fakePi(), fakeCommandContext(), "failing-snapshot-test", loadedWorkflow(mod), "failed args", {}), /boom/);

  const inspection = getLastWorkflowInspection();
  assert.equal(inspection?.name, "failing-snapshot-test");
  assert.equal(inspection?.args, "failed args");
  assert.equal(typeof inspection?.snapshot.doneAt, "number");
  assert.ok(inspection?.snapshot.logs.includes("failing workflow log"));
  assert.equal(inspection?.snapshot.lanes[0]?.[1][0]?.details, "boom details");
});

test("runWorkflow preserves the workflow error when finalization callbacks also fail", async () => {
  const mod: WorkflowModule = {
    meta: { name: "primary-failure-test", description: "primary failure" },
    default: async () => {
      throw new Error("workflow failed first");
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
        onUsageSnapshot() {
          throw new Error("finalization callback also failed");
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /workflow failed first/);
      assert.match(error.message, /finalization callback also failed/);
      assert.equal(error.errors.length, 2);
      assert.match(String(error.errors[0]), /workflow failed first/);
      assert.ok(error.errors[1] instanceof AggregateError);
      return true;
    },
  );
});

test("runWorkflow reports finalization failures after a successful workflow", async () => {
  const mod: WorkflowModule = {
    meta: { name: "finalization-failure-test", description: "finalization failure" },
    default: async () => "ok",
  };

  await assert.rejects(
    () =>
      runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
        onUsageSnapshot() {
          throw new Error("finalization callback failed");
        },
      }),
    /finalization callback failed/,
  );
});

test("runWorkflow composes an additional abort signal during repository capture", async () => {
  const controller = new AbortController();
  controller.abort(new Error("tool aborted"));
  let workflowExecuted = false;
  const progressSources: Array<WorkflowProgressSource | undefined> = [];
  let progressSnapshot: WorkflowProgressSnapshot | undefined;
  const mod: WorkflowModule = {
    meta: { name: "signal-test", description: "signal" },
    default: async () => {
      workflowExecuted = true;
      return "unexpected";
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(fakeContext(), loadedWorkflow(mod), "", {
        signal: controller.signal,
        onProgressSource: (source) => progressSources.push(source),
        onProgressSnapshot: (snapshot) => {
          progressSnapshot = snapshot;
        },
      }),
    /tool aborted/,
  );
  assert.equal(workflowExecuted, false);
  assert.equal(progressSources.length, 2);
  assert.ok(progressSources[0]);
  assert.equal(progressSources[1], undefined);
  assert.equal(typeof progressSnapshot?.doneAt, "number");
});

test("sendWorkflowResult publishes the review before reporting an unavailable fix snapshot", async () => {
  const events: string[] = [];
  const pi = {
    sendMessage(message: unknown) {
      if (typeof message === "object" && message !== null && "details" in message) {
        const details = message.details;
        if (typeof details === "object" && details !== null && "name" in details && typeof details.name === "string") {
          events.push(`message:${details.name}`);
        }
      }
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    ...fakeCommandContext(),
    hasUI: true,
    mode: "tui",
    ui: {
      async custom() {
        return { action: "fix", issueIds: ["R001"] };
      },
      notify(message: string) {
        events.push(`notify:${message}`);
      },
      setStatus() {},
      setWidget() {},
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
      },
    },
  } as unknown as ExtensionCommandContext;
  const mod: WorkflowModule = {
    meta: { name: "code-review", description: "review" },
    default: async () => ({
      summary: "Review complete.",
      findings: [
        {
          summary: "Off-by-one.",
          category: "bug",
          severity: "high",
          confidence: "high",
          locations: [{ file: "src/app.ts", line: 10 }],
          evidence: ["line 10"],
          impact: "A retry is skipped.",
          recommendation: "Fix the boundary.",
        },
      ],
      nextSteps: [],
      reviewContext: { workflowName: "code-review", target: "", diffCommand: "git diff", files: ["src/app.ts"] },
    }),
  };

  await sendWorkflowResult(pi, ctx, "code-review", loadedWorkflow(mod), "", { resultViewer: "open" });

  assert.equal(events[0], "message:code-review");
  assert.equal(events[1], "notify:Verifying the reviewed snapshot before generating patch previews");
  assert.match(events[2] ?? "", /^notify:Patch preview unavailable because the review was not captured/);
});
