import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import { showReviewResultsViewer, type ReviewResultsViewerContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-flow.ts";
import { toReviewIssues, type ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import { isReviewReport } from "../.pi/extensions/pi-workflow-engine/src/review/review-report.ts";
import { ReviewSessionCoordinator } from "../.pi/extensions/pi-workflow-engine/src/review/review-session-coordinator.ts";

test("code-review results open the viewer only when it is requested in the TUI", async () => {
  const cases = [
    { name: "code-review", result: createReport(), mode: "tui", resultViewer: "open", opens: true },
    { name: "code-review", result: createReport(), mode: "tui", resultViewer: undefined, opens: false },
    { name: "code-review", result: createReport(), mode: "tui", resultViewer: "skip", opens: false },
    { name: "code-review", result: { ...createReport(), findings: [] }, mode: "tui", resultViewer: "open", opens: false },
    { name: "code-review", result: createReport(), mode: "rpc", resultViewer: "open", opens: false },
    { name: "refactor-scout", result: createReport(), mode: "tui", resultViewer: "open", opens: false },
  ] as const;
  for (const { name, result, mode, resultViewer, opens } of cases) {
    let opened = 0;
    const ctx = {
      mode,
      hasUI: true,
      sessionManager: { getSessionFile: () => "/session.jsonl", getSessionId: () => "session" },
      ui: {
        async custom() {
          opened++;
          return { action: "close", issueIds: [] };
        },
        notify() {},
      },
    } as unknown as ExtensionContext;
    const coordinator = new ReviewSessionCoordinator(
      { sendUserMessage() {}, async exec() { throw new Error("unexpected exec"); } },
      { async runFollowUp() { throw new Error("unexpected follow-up"); }, publish() {} },
    );
    const execution = { envelope: { name, result, completedAt: 0 } };
    const options = resolveWorkflowRunOptions(resultViewer ? { resultViewer } : {}, {});

    coordinator.remember(ctx, execution, options);
    await coordinator.present(ctx, execution, options);

    assert.equal(opened, opens ? 1 : 0, `${name} ${mode} ${resultViewer ?? "default"} ${result.findings.length} finding(s)`);
  }
});

test("the review results viewer opens as an overlay and returns its action", async () => {
  let customCalls = 0;
  let customOptions: unknown;
  const custom: ReviewResultsViewerContext["ui"]["custom"] = async <T>(_factory: unknown, options?: unknown): Promise<T> => {
    customCalls++;
    customOptions = options;
    return { action: "close", issueIds: ["R001"] } as T;
  };
  const action = await showReviewResultsViewer({ ui: { custom } }, toReviewIssues(createReport()));

  assert.equal(customCalls, 1);
  assert.deepEqual(customOptions, {
    overlay: true,
    overlayOptions: { anchor: "center", width: "80%", minWidth: 40, maxHeight: "80%", margin: 1 },
  });
  assert.deepEqual(action, { action: "close", issueIds: ["R001"] } satisfies ReviewIssueSelection);
});

test("code-review retention rejects malformed action context", () => {
  const malformedContexts = [
    { workflowName: "code-review", target: "PR", files: ["src/app.ts"] },
    { workflowName: "code-review", target: "PR", diffTarget: { kind: "pull-request", number: 1 }, files: "src/app.ts" },
    {
      workflowName: "code-review",
      target: "PR",
      diffTarget: { kind: "pull-request", number: 1 },
      files: ["src/app.ts"],
      snapshot: { diffFingerprint: "a".repeat(64) },
    },
    {
      workflowName: "code-review",
      target: "PR",
      diffTarget: { kind: "git", args: ["diff", "--output=owned"] },
      files: ["src/app.ts"],
    },
  ];
  for (const reviewContext of malformedContexts) {
    assert.equal(isReviewReport({ ...createReport(), reviewContext }), false);
  }
});

function createReport(): AdvisoryReport {
  return {
    summary: "Review complete.",
    findings: [
      {
        summary: "Off-by-one in retry loop.",
        category: "bug",
        severity: "high",
        confidence: "high",
        locations: [{ file: "src/app.ts", line: 10, symbol: "retry" }],
        evidence: ["line 10 increments before checking the limit"],
        impact: "A final retry is skipped.",
        recommendation: "Change the loop boundary after adding a regression test.",
      },
    ],
    nextSteps: ["Inspect src/app.ts retry loop"],
  };
}
