import assert from "node:assert/strict";
import { test } from "bun:test";
import runCodeReview from "../.pi/extensions/pi-workflow-engine/workflows/code-review.ts";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

function scopeOnlyApi(diffCommand: string, cwd = process.cwd()): WorkflowApi {
  return {
    args: "",
    cwd,
    signal: undefined,
    agent: async () => ({
      diffCommand,
      files: ["src/app.ts"],
      summary: "Test review target",
    }),
    parallel: async () => {
      throw new Error("review must stop before fan-out");
    },
    phase() {},
    log() {},
    progress() {},
  } as unknown as WorkflowApi;
}

test("code review rejects patch-series pull-request targets as a failed run", async () => {
  await assert.rejects(
    () => runCodeReview(scopeOnlyApi("gh pr diff 123 --patch")),
    /Code-review target rejected: gh pr diff --patch is not supported/,
  );
});

test("code review reports initial diff-capture failure as a failed run", async () => {
  await assert.rejects(
    () => runCodeReview(scopeOnlyApi("git diff"), {
      captureReviewMaterial: async () => ({ ok: false, error: "diff capture timed out" }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Code-review diff capture failed: diff capture timed out/);
      assert.doesNotMatch(error.message, /No findings/);
      return true;
    },
  );
});
