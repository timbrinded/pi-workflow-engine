import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { decideReviewResultsPresentation, reviewResultsConfirmMessage } from "../.pi/extensions/pi-workflow-engine/src/review/review-results-flow.ts";

test("direct code-review asks for viewer only when findings exist", () => {
  const ask = decideReviewResultsPresentation({ workflowName: "code-review", result: createReport(), mode: "tui", hasUI: true });
  assert.equal(ask.kind, "ask");
  if (ask.kind !== "ask") throw new Error("expected ask decision");
  assert.equal(ask.findingCount, 1);
  assert.deepEqual(ask.issues.map((issue) => issue.id), ["R001"]);
  assert.equal(reviewResultsConfirmMessage(ask.findingCount), "Review produced 1 finding(s). Open the interactive results viewer?");

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
