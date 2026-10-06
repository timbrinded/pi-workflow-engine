import assert from "node:assert/strict";
import { test } from "bun:test";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { PhaseSnapshot, WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import {
  WorkflowRunsBrowser,
  type WorkflowRunsBrowserChoice,
  type WorkflowRunsBrowserOptions,
  type WorkflowRunsListing,
} from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-runs-browser.ts";
import { emptyWorkflowUsageTotals, type WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { WorkflowRunActionContext } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-history.ts";
import { createWorkflowRunRecord, transitionWorkflowRun, type WorkflowRunRecord } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

const NOW = 1_760_000_000_000;
const DOWN = "\u001b[B";

const COMPLETED_ID = "3cfb22c2-5434-4359-ad9f-67ed0af1dabb";
const RUNNING_ID = "56b57550-1111-4359-ad9f-67ed0af1dabb";
const FAILED_ID = "c027e53a-a498-48eb-9c86-dd8d4dabd6ec";
const PAUSED_ID = "aa27e53a-a498-48eb-9c86-dd8d4dabd6ec";
const ARGS_ID = "bb27e53a-a498-48eb-9c86-dd8d4dabd6ec";

test("run rows align their columns, shorten run ids and hide zero cost", () => {
  const lines = render(createBrowser().browser, 112);
  const rows = lines.filter((line) => /^│ [› ] [✓●✗⚠■○] /.test(line));

  assert.equal(rows.length, 5);
  assert.ok(lines.every((line) => !line.includes(COMPLETED_ID)), "no full run ids");
  assert.match(rows[0] ?? "", /^│ › ✓ code-review\s+completed\s+4s\s+2m ago\s+\$0\.02\s+3cfb22c2 /);
  assert.equal(new Set(rows.map((row) => row.indexOf(row.match(/[0-9a-f]{8} +│$/)?.[0] ?? "?"))).size, 1, "run ids share one column");
  assert.match(rows[1] ?? "", /● repo-scan\s+running/);
  assert.doesNotMatch(rows[1] ?? "", /\$0(?!\.)/, "a run without cost shows no $0");
  assert.match(lines[0] ?? "", /Workflow runs .* 5 runs · 1 active · 1 paused · 1 failed ─╮$/);
});

test("every line fits the overlay width and narrow overlays drop columns before wrapping", () => {
  for (const width of [140, 112, 90, 72, 50]) {
    const { browser } = createBrowser();
    for (const key of ["", DOWN, DOWN, DOWN]) {
      if (key) browser.handleInput(key);
      assert.ok(browser.render(width).every((line) => visibleWidth(line) === width), `width ${width}`);
    }
  }
  const narrow = render(createBrowser().browser, 50).filter((line) => /^│ [› ] [✓●✗⚠■○] /.test(line));
  assert.ok(narrow.every((row) => !/\$0\.02/.test(row)), "cost is the first column to go");
});

test("the details pane adds facts the row does not show and explains unavailable relaunches", () => {
  const { browser } = createBrowser();
  const completed = render(browser, 112).join("\n");
  assert.match(completed, /Phases\s+Scope → Find\s+│/);
  assert.doesNotMatch(completed, /Workflow →/, "the empty implicit phase is noise");
  assert.match(completed, /Agents\s+3 · 1 failed/);
  assert.match(completed, /Tokens\s+↑34k ↓1k/);
  assert.match(completed, /Outcome\s+3 findings · Concurrent callers can observe the cache/);
  assert.doesNotMatch(completed, /Started.*ago/, "age stays in the row");

  for (let index = 0; index < 3; index++) browser.handleInput(DOWN);
  const paused = render(browser, 112).join("\n");
  assert.match(paused, /Paused\s+provider usage limit · attempt 1\/3 · eligible in 3m · auto-resume on/);

  browser.handleInput(DOWN);
  assert.match(render(browser, 112).join("\n"), /Restart\s+unavailable · its arguments were not retained/);
});

test("the overlay keeps one height while the cursor moves between runs", () => {
  const { browser } = createBrowser();
  const heights = [browser.render(112).length];
  for (let index = 0; index < 4; index++) {
    browser.handleInput(DOWN);
    heights.push(browser.render(112).length);
  }
  assert.equal(new Set(heights).size, 1);
});

test("footer hints follow the cursor run's available actions", () => {
  const { browser } = createBrowser();
  assert.match(footer(browser), /↑↓ move · enter inspect · R restart · q close/);
  browser.handleInput(DOWN);
  assert.match(footer(browser), /enter inspect · s stop · q close/);
  browser.handleInput(DOWN);
  browser.handleInput(DOWN);
  assert.match(footer(browser), /enter inspect · s stop · r resume · q close/);
  browser.handleInput(DOWN);
  assert.match(footer(browser), /↑↓ move · enter inspect · q close/);
});

test("action keys are gated by availability, and stop takes a second press", () => {
  const completed = createBrowser();
  completed.browser.handleInput("r");
  assert.equal(completed.choice(), undefined);
  assert.match(footer(completed.browser), /⚠ resume is not available for a completed run/);
  completed.browser.handleInput("R");
  assert.deepEqual(completed.choice(), { action: "restart", runId: COMPLETED_ID });

  const inspect = createBrowser();
  inspect.browser.handleInput(DOWN);
  inspect.browser.handleInput("\r");
  assert.deepEqual(inspect.choice(), { action: "inspect", runId: RUNNING_ID });

  const stop = createBrowser();
  stop.browser.handleInput(DOWN);
  stop.browser.handleInput("s");
  assert.equal(stop.choice(), undefined);
  assert.match(footer(stop.browser), /⚠ press s again to stop repo-scan 56b57550/);
  stop.browser.handleInput("s");
  assert.deepEqual(stop.choice(), { action: "stop", runId: RUNNING_ID });

  const disarmed = createBrowser();
  disarmed.browser.handleInput(DOWN);
  disarmed.browser.handleInput("s");
  disarmed.browser.handleInput(DOWN);
  disarmed.browser.handleInput("s");
  assert.equal(disarmed.choice(), undefined, "another key disarms the pending stop");

  const withArgs = createBrowser();
  for (let index = 0; index < 4; index++) withArgs.browser.handleInput(DOWN);
  withArgs.browser.handleInput("R");
  assert.equal(withArgs.choice(), undefined);
  assert.match(footer(withArgs.browser), /restart unavailable · its arguments were not retained/);

  const superseded = createBrowser({ resumedAs: new Map([[PAUSED_ID, FAILED_ID]]) });
  for (let index = 0; index < 3; index++) superseded.browser.handleInput(DOWN);
  superseded.browser.handleInput("r");
  assert.match(footer(superseded.browser), /already resumed as c027e53a/);
  assert.match(render(superseded.browser, 112).join("\n"), /Resumed\s+superseded by c027e53a/);
});

test("the cursor can start on a given run and q closes without a choice", () => {
  const { browser, choice, closed } = createBrowser({}, PAUSED_ID);
  assert.match(render(browser, 112).find((line) => line.startsWith("│ ›")) ?? "", /diagnose/);
  browser.handleInput("q");
  assert.equal(choice(), undefined);
  assert.equal(closed(), true);
});

test("a live listing refreshes in place, keeps the cursor on its run, and stops polling once settled", async () => {
  let reloads = 0;
  const { browser } = createBrowser({}, RUNNING_ID, {
    refreshMs: 5,
    refresh: async () => {
      reloads++;
      return listing({}, "completed");
    },
  });
  assert.match(render(browser, 112).find((line) => line.startsWith("│ ›")) ?? "", /● repo-scan\s+running/);

  for (let attempt = 0; attempt < 100 && reloads === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(reloads, 1);
  assert.match(render(browser, 112).find((line) => line.startsWith("│ ›")) ?? "", /✓ repo-scan\s+completed/);
  assert.match(footer(browser), /R restart/, "actions follow the refreshed state");

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(reloads, 1, "no polling once nothing is queued or running");
  browser.dispose();
});

test("a settled listing never polls", async () => {
  let reloads = 0;
  const tui = { requestRender() {}, terminal: { rows: 45, columns: 140 } } as Pick<TUI, "requestRender" | "terminal">;
  const browser = new WorkflowRunsBrowser(listing({}, "completed"), tui, createTestTheme(), () => {}, {
    refreshMs: 5,
    refresh: async () => {
      reloads++;
      return listing({}, "completed");
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reloads, 0);
  browser.dispose();
});

function footer(browser: WorkflowRunsBrowser): string {
  return render(browser, 112).at(-1) ?? "";
}

function render(browser: WorkflowRunsBrowser, width: number): string[] {
  return browser.render(width).map(plain);
}

function listing(context: Partial<WorkflowRunActionContext> = {}, runningState: "running" | "completed" = "running"): WorkflowRunsListing {
  return {
    records: [
      record(COMPLETED_ID, "code-review", "completed", NOW - 120_000),
      record(RUNNING_ID, "repo-scan", runningState, NOW - 12_000),
      record(FAILED_ID, "code-review", "failed", NOW - 300_000),
      record(PAUSED_ID, "diagnose", "paused", NOW - 3_600_000),
      record(ARGS_ID, "perf-review", "stopped", NOW - 90_000_000, true),
    ],
    runs: {
      activeRunIds: context.activeRunIds ?? new Set(runningState === "running" ? [RUNNING_ID] : []),
      resumedAs: context.resumedAs ?? new Map(),
    },
  };
}

function createBrowser(
  context: Partial<WorkflowRunActionContext> = {},
  initialRunId?: string,
  options: Pick<WorkflowRunsBrowserOptions, "refresh" | "refreshMs"> = {},
): { readonly browser: WorkflowRunsBrowser; readonly choice: () => WorkflowRunsBrowserChoice | undefined; readonly closed: () => boolean } {
  let choice: WorkflowRunsBrowserChoice | undefined;
  let closed = false;
  const tui = { requestRender() {}, terminal: { rows: 45, columns: 140 } } as Pick<TUI, "requestRender" | "terminal">;
  const browser = new WorkflowRunsBrowser(listing(context), tui, createTestTheme(), (value) => {
    choice = value;
    closed = true;
  }, { ...options, initialRunId, now: () => NOW });
  return { browser, choice: () => choice, closed: () => closed };
}

function record(
  runId: string,
  name: string,
  state: "completed" | "failed" | "running" | "paused" | "stopped",
  createdAt: number,
  argumentsPresent = false,
): WorkflowRunRecord {
  const workflow: LoadedWorkflow = {
    meta: { name, description: name },
    default: async () => ({}),
    source: { kind: "file", path: `/extension/workflows/${name}.ts`, root: "/extension", fingerprint: "source" },
  };
  const phases = (failed: boolean): PhaseSnapshot[] => [
    { title: "Workflow", agents: [] },
    { title: "Scope", agents: [{ id: 1, label: "scope", status: "done", toolUses: 1, startedAt: 1, doneAt: 2 }] },
    {
      title: "Find",
      agents: [
        { id: 2, label: "logic", status: "done", toolUses: 1, startedAt: 1, doneAt: 2 },
        { id: 3, label: "error-paths", status: failed ? "failed" : "done", toolUses: 1, startedAt: 1, doneAt: 2 },
      ],
    },
  ];
  const progress = (failed = state !== "running"): WorkflowProgressSnapshot => ({
    runId,
    title: name,
    startedAt: createdAt,
    currentPhase: "Find",
    phases: phases(failed && state !== "paused"),
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  });
  const usage: WorkflowUsageSnapshot = {
    agents: [],
    assistantMessages: 3,
    totals: {
      ...emptyWorkflowUsageTotals(),
      input: 30_000,
      cacheRead: 4_000,
      output: 1_000,
      totalTokens: 35_000,
      cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0, total: 0.02 },
    },
  };
  const queued = createWorkflowRunRecord({ runId, workflow, options: resolveWorkflowRunOptions({}, {}), progress: progress(), argumentsPresent });
  const running = transitionWorkflowRun(queued, { state: "running", progress: progress(), at: createdAt });
  if (state === "running") return running;
  if (state === "completed") {
    return transitionWorkflowRun(running, {
      state,
      progress: progress(),
      usage,
      result: { summary: "Concurrent callers can observe the cache before the first writer finishes.", findings: [1, 2, 3] },
      at: createdAt + 4_000,
    });
  }
  if (state === "paused") {
    return transitionWorkflowRun(running, {
      state,
      progress: progress(),
      message: "Paused at a provider usage limit.",
      pause: {
        kind: "provider_usage_limit",
        reason: "provider_usage_limit",
        providerMessage: "429",
        attempt: 1,
        nextEligibleAt: NOW + 180_000,
        autoResume: true,
        maxAttempts: 3,
      },
      at: createdAt + 2_000,
    });
  }
  return transitionWorkflowRun(running, {
    state,
    progress: progress(),
    usage: { ...usage, totals: emptyWorkflowUsageTotals() },
    error: new Error("injected failure for error-paths"),
    at: createdAt + 135,
  });
}
