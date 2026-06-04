import assert from "node:assert/strict";
import { test } from "bun:test";
import { defaultConcurrency, resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import { parseWorkflowInvocation } from "../.pi/extensions/pi-workflow-engine/index.ts";

test("defaultConcurrency preserves existing formula", () => {
  assert.equal(defaultConcurrency(1), 2);
  assert.equal(defaultConcurrency(2), 2);
  assert.equal(defaultConcurrency(16), 8);
});

test("resolveWorkflowRunOptions clamps env and explicit tuning", () => {
  const env = {
    PI_WORKFLOW_PERF: "1",
    PI_WORKFLOW_CONCURRENCY: "999",
    PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT: "0",
  };
  assert.deepEqual(resolveWorkflowRunOptions({}, env), {
    perf: true,
    concurrency: 64,
    parallelSubmissionLimit: 1,
  });

  assert.equal(resolveWorkflowRunOptions({ concurrency: -5 }, {}).concurrency, 1);
  assert.equal(resolveWorkflowRunOptions({ parallelSubmissionLimit: 20_000 }, {}).parallelSubmissionLimit, 10_000);
});

test("parseWorkflowInvocation extracts tuning flags from slash command args", () => {
  const invocation = parseWorkflowInvocation("code-review --inspect --concurrency=4 --parallel-limit 9 review src only");

  assert.equal(invocation.name, "code-review");
  assert.equal(invocation.args, "review src only");
  assert.deepEqual(invocation.options, { inspect: true, concurrency: 4, parallelSubmissionLimit: 9 });
});
