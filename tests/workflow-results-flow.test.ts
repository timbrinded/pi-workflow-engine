import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import {
  codeReviewReport,
  decideReviewResultsPresentation,
  showReviewResultsViewer,
  type ReviewResultsViewerContext,
} from "../.pi/extensions/pi-workflow-engine/src/review/review-results-flow.ts";
import type { ReviewIssueSelection } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";

test("direct code-review sends results unless viewer is explicitly requested", () => {
  const notRequested = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "tui", hasUI: true });
  assert.deepEqual(notRequested, { kind: "send", reason: "not-requested" });

  const empty = decideReviewResultsPresentation({ workflowName: "code-review", result: { ...createReport(), findings: [] }, mode: "tui", hasUI: true });
  assert.deepEqual(empty, { kind: "send", reason: "no-findings" });

  const generic = decideReviewResultsPresentation({ workflowName: "refactor-scout", result: createReport(), mode: "tui", hasUI: true });
  assert.deepEqual(generic, { kind: "send", reason: "not-code-review" });

  const nonTui = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "rpc", hasUI: true });
  assert.deepEqual(nonTui, { kind: "send", reason: "not-tui" });
});

test("result viewer options can force open or skip", () => {
  const open = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "tui", hasUI: true, resultViewer: "open" });
  assert.equal(open.kind, "open");

  const skip = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "tui", hasUI: true, resultViewer: "skip" });
  assert.deepEqual(skip, { kind: "send", reason: "disabled" });
});

test("forced-open direct code-review flow opens the viewer and returns its action", async () => {
  let customCalls = 0;
  let customOptions: unknown;
  const custom: ReviewResultsViewerContext["ui"]["custom"] = async <T>(_factory: unknown, options?: unknown): Promise<T> => {
    customCalls++;
    customOptions = options;
    return { action: "close", issueIds: ["R001"] } as T;
  };
  const ctx: ReviewResultsViewerContext = {
    ui: { custom },
  };
  const decision = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "tui", hasUI: true, resultViewer: "open" });
  assert.equal(decision.kind, "open");
  if (decision.kind !== "open") assert.fail("expected viewer decision");
  const action = await showReviewResultsViewer(ctx, decision.issues);

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
    assert.equal(codeReviewReport("code-review", { ...createReport(), reviewContext }), undefined);
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
