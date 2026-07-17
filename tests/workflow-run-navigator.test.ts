import assert from "node:assert/strict";
import { test } from "bun:test";
import type { TUI } from "@earendil-works/pi-tui";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { emptyWorkflowUsageTotals } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import {
  availableWorkflowRunActions,
  formatWorkflowRunDuration,
  formatWorkflowRunDetails,
  formatWorkflowRunHistory,
  parseWorkflowRunsCommand,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-history.ts";
import {
  createWorkflowRunRecord,
  transitionWorkflowRun,
  type WorkflowRunRecord,
  type WorkflowRunState,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import {
  renderWorkflowRunNavigatorLines,
  WorkflowRunNavigator,
  type WorkflowRunNavigatorSelection,
} from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-run-navigator.ts";
import { createTestTheme } from "./fixtures/theme.ts";

const now = 10_000;
const usage = { agents: [], totals: emptyWorkflowUsageTotals(), assistantMessages: 0 };

function workflow(name: string): LoadedWorkflow {
  return {
    meta: { name, description: `${name} workflow` },
    default: async () => ({ summary: "done" }),
    source: { kind: "file", path: `${name}.ts`, root: "/repo", fingerprint: `source:${name}` },
  };
}

function progress(runId: string, state: WorkflowRunState): WorkflowProgressSnapshot {
  const terminal = state === "completed" || state === "failed" || state === "stopped";
  return {
    runId,
    title: `workflow-${state}`,
    startedAt: 1_000,
    doneAt: terminal ? 5_000 : undefined,
    currentPhase: "Verify",
    phases: [{
      title: "Find",
      agents: [{
        id: 1,
        label: "finder",
        status: state === "failed" ? "failed" : terminal ? "done" : "running",
        startedAt: 2_000,
        doneAt: terminal ? 4_000 : undefined,
        toolUses: 2,
      }],
    }],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  };
}

function record(
  state: WorkflowRunState,
  index = 0,
  argumentsPresent = false,
  background = true,
): WorkflowRunRecord {
  const runId = `${state}-run-${index}`;
  const initial = createWorkflowRunRecord({
    runId,
    workflow: workflow(`workflow-${state}`),
    options: resolveWorkflowRunOptions(background
      ? { background: { sessionId: "session-runs", requestedAt: 1_000 } }
      : {}),
    progress: progress(runId, "queued"),
    argumentsPresent,
  });
  if (state === "queued") return initial;
  const running = transitionWorkflowRun(initial, { state: "running", progress: progress(runId, "running"), at: 2_000 });
  switch (state) {
    case "running":
      return running;
    case "paused":
      return transitionWorkflowRun(running, { state: "paused", progress: progress(runId, state), message: "provider paused", at: 4_000 });
    case "completed":
      return transitionWorkflowRun(running, { state, progress: progress(runId, state), usage, result: { summary: "retained" }, at: 5_000 });
    case "failed":
    case "stopped":
      return transitionWorkflowRun(running, { state, progress: progress(runId, state), usage, error: `${state} reason`, at: 5_000 });
  }
}

test("workflow run commands parse only namespaced list and lifecycle actions", () => {
  assert.deepEqual(parseWorkflowRunsCommand(""), { kind: "list" });
  assert.deepEqual(parseWorkflowRunsCommand("inspect abc"), { kind: "action", action: "inspect", runId: "abc" });
  assert.deepEqual(parseWorkflowRunsCommand("resume abc"), { kind: "action", action: "resume", runId: "abc" });
  assert.equal(parseWorkflowRunsCommand("delete abc").kind, "error");
  assert.equal(parseWorkflowRunsCommand("stop").kind, "error");
});

test("workflow run lifecycle actions are gated by state, local activity, and safe replay context", () => {
  assert.deepEqual(availableWorkflowRunActions(record("queued"), true), ["inspect", "stop"]);
  assert.deepEqual(availableWorkflowRunActions(record("running"), true), ["inspect", "stop"]);
  assert.deepEqual(availableWorkflowRunActions(record("running"), false), ["inspect"]);
  assert.deepEqual(availableWorkflowRunActions(record("paused"), false), ["inspect", "resume"]);
  assert.deepEqual(availableWorkflowRunActions(record("completed"), false), ["inspect", "restart"]);
  assert.deepEqual(availableWorkflowRunActions(record("failed"), false), ["inspect", "restart"]);
  assert.deepEqual(availableWorkflowRunActions(record("stopped"), false), ["inspect", "restart"]);
  assert.deepEqual(availableWorkflowRunActions(record("completed", 0, false, false), false), ["inspect", "restart"]);
  assert.deepEqual(availableWorkflowRunActions(record("paused", 0, true), false), ["inspect"]);
  assert.equal(formatWorkflowRunDuration(record("paused"), now), "2s");
});

test("headless run history and details expose mixed states, identifiers, phases, agents, and outcomes", () => {
  const records = [record("queued"), record("running"), record("paused"), record("completed"), record("failed"), record("stopped")];
  const history = formatWorkflowRunHistory(records, new Set([records[0]!.runId]), now);
  assert.match(history, /QUEUED/);
  assert.match(history, /RUNNING/);
  assert.match(history, /PAUSED/);
  assert.match(history, /COMPLETED/);
  assert.match(history, /FAILED/);
  assert.match(history, /STOPPED/);
  assert.match(history, /running-run-0/);
  assert.match(history, /actions stop/);

  const detail = formatWorkflowRunDetails(records[3]!, false, now);
  assert.match(detail, /Find \/ finder: done/);
  assert.match(detail, /"summary": "retained"/);
  assert.match(detail, /Actions: inspect, restart/);
  assert.equal(formatWorkflowRunHistory([], new Set(), now), "No durable workflow runs are available for this project.");
});

test("workflow run navigator is bounded and renders accessible state labels", () => {
  const records = Array.from({ length: 100 }, (_value, index) => record(index % 2 === 0 ? "running" : "completed", index));
  const lines = renderWorkflowRunNavigatorLines(
    records,
    new Set([records[0]!.runId]),
    0,
    120,
    14,
    createTestTheme(),
    now,
  );
  assert.equal(lines.length, 14);
  assert.match(lines.join("\n"), /RUNNING/);
  assert.match(lines.join("\n"), /s stop/);
  assert.doesNotMatch(lines.join("\n"), /running-run-98/);
});

test("workflow run navigator emits only actions valid for the selected run", () => {
  const tui = { requestRender() {}, terminal: { rows: 24, columns: 120 } } as Pick<TUI, "requestRender" | "terminal">;
  const theme = createTestTheme();
  let selection: WorkflowRunNavigatorSelection | undefined;
  new WorkflowRunNavigator([record("paused")], new Set(), tui, theme, (value) => {
    selection = value;
  }).handleInput("r");
  assert.deepEqual(selection, { action: "resume", runId: "paused-run-0" });

  selection = undefined;
  new WorkflowRunNavigator([record("running")], new Set(), tui, theme, (value) => {
    selection = value;
  }).handleInput("s");
  assert.equal(selection, undefined);

  new WorkflowRunNavigator([record("running")], new Set(["running-run-0"]), tui, theme, (value) => {
    selection = value;
  }).handleInput("s");
  assert.deepEqual(selection, { action: "stop", runId: "running-run-0" });

  selection = undefined;
  const navigator = new WorkflowRunNavigator([record("running"), record("completed")], new Set(), tui, theme, (value) => {
    selection = value;
  });
  navigator.handleInput("\u001b[B");
  navigator.handleInput("\r");
  assert.deepEqual(selection, { action: "inspect", runId: "completed-run-0" });
});
