import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConcurrency, resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowModule } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { buildTemporaryWorkflowAuthorPrompt, parseWorkflowInvocation, pickWorkflow } from "../.pi/extensions/pi-workflow-engine";

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
    budget: null,
  });

  assert.equal(resolveWorkflowRunOptions({ concurrency: -5 }, {}).concurrency, 1);
  assert.equal(resolveWorkflowRunOptions({ parallelSubmissionLimit: 20_000 }, {}).parallelSubmissionLimit, 10_000);
});

test("parseWorkflowInvocation extracts tuning flags from slash command args", () => {
  const invocation = parseWorkflowInvocation("code-review --inspect --perf --concurrency=4 --parallel-limit 9 --budget 50000 --resume old-run review src only");

  assert.equal(invocation.name, "code-review");
  assert.equal(invocation.args, "review src only");
  assert.deepEqual(invocation.options, {
    inspect: true,
    perf: true,
    concurrency: 4,
    parallelSubmissionLimit: 9,
    budget: 50000,
    resumeFromRunId: "old-run",
  });

  const equalsForm = parseWorkflowInvocation("code-review --budget=50000 --resume=old-run review src only");
  assert.equal(equalsForm.args, "review src only");
  assert.deepEqual(equalsForm.options, { budget: 50000, resumeFromRunId: "old-run" });
});

test("parseWorkflowInvocation preserves concurrency value consumption semantics", () => {
  const equalsForm = parseWorkflowInvocation("code-review --concurrency=4 review src");
  assert.equal(equalsForm.options.concurrency, 4);
  assert.equal(equalsForm.args, "review src");

  const nextTokenForm = parseWorkflowInvocation("code-review --concurrency 4 review src");
  assert.equal(nextTokenForm.options.concurrency, 4);
  assert.equal(nextTokenForm.args, "review src");

  const invalidValue = parseWorkflowInvocation("code-review --concurrency nope review src");
  assert.equal(invalidValue.options.concurrency, undefined);
  assert.equal(invalidValue.args, "review src");

  const consumedOptionToken = parseWorkflowInvocation("code-review --concurrency --perf review src");
  assert.equal(consumedOptionToken.options.concurrency, undefined);
  assert.equal(consumedOptionToken.options.perf, undefined);
  assert.equal(consumedOptionToken.args, "review src");
});

test("parseWorkflowInvocation rejects invalid budget flags without consuming positional args", () => {
  const cases = [
    { input: "code-review --budget", args: "" },
    { input: "code-review --budget=", args: "" },
    { input: "code-review --budget=abc review src", args: "review src" },
    { input: "code-review --budget review src", args: "review src" },
    { input: "code-review --budget=0 review src", args: "review src" },
    { input: "code-review --budget=-1 review src", args: "review src" },
    { input: "code-review --budget=1.5 review src", args: "review src" },
  ];

  for (const item of cases) {
    const invocation = parseWorkflowInvocation(item.input);
    assert.equal(invocation.args, item.args, item.input);
    assert.equal(invocation.options.budget, undefined, item.input);
    assert.deepEqual(invocation.optionErrors, ["--budget requires a positive integer output-token count"], item.input);
  }
});

test("parseWorkflowInvocation rejects invalid resume flags without consuming positional args", () => {
  const cases = [
    { input: "code-review --resume", args: "" },
    { input: "code-review --resume=", args: "" },
    { input: "code-review --resume --inspect review src", args: "review src" },
  ];

  for (const item of cases) {
    const invocation = parseWorkflowInvocation(item.input);
    assert.equal(invocation.args, item.args, item.input);
    assert.equal(invocation.options.resumeFromRunId, undefined, item.input);
    assert.deepEqual(invocation.optionErrors, ["--resume requires a workflow run id"], item.input);
  }
});

test("resolveWorkflowRunOptions resolves budget env values strictly and rejects non-finite explicit budgets", () => {
  assert.equal(resolveWorkflowRunOptions({}, { PI_WORKFLOW_BUDGET: "50000" }).budget, 50000);

  for (const value of ["abc", "", "0", "1.5"]) {
    assert.equal(resolveWorkflowRunOptions({}, { PI_WORKFLOW_BUDGET: value }).budget, null, value);
  }

  assert.throws(() => resolveWorkflowRunOptions({ budget: Number.NaN }, {}), RangeError);
  assert.throws(() => resolveWorkflowRunOptions({ budget: Infinity }, {}), RangeError);
});

test("resolved workflow options remain plain spreadable data", () => {
  const resolved = resolveWorkflowRunOptions({}, { PI_WORKFLOW_BUDGET: "100" });

  assert.deepEqual({ ...resolved }, resolved);
  assert.deepEqual(Object.getOwnPropertySymbols(resolved), []);
});

test("parses result viewer workflow options", () => {
  const forcedOpen = parseWorkflowInvocation("code-review --result-viewer review src only");
  assert.equal(forcedOpen.name, "code-review");
  assert.equal(forcedOpen.args, "review src only");
  assert.deepEqual(forcedOpen.options, { resultViewer: "open" });

  const aliasOpen = parseWorkflowInvocation("code-review --review-viewer review src only");
  assert.deepEqual(aliasOpen.options, { resultViewer: "open" });

  const forcedSkip = parseWorkflowInvocation("code-review --no-result-viewer --no-review-viewer review src only");
  assert.equal(forcedSkip.args, "review src only");
  assert.deepEqual(forcedSkip.options, { resultViewer: "skip" });

  const normalText = parseWorkflowInvocation("code-review result viewer should inspect docs only");
  assert.equal(normalText.args, "result viewer should inspect docs only");
  assert.deepEqual(normalText.options, {});
});

test("pickWorkflow does not prompt for inspector by default", async () => {
  let confirmCalls = 0;
  const workflows = new Map<string, WorkflowModule>([
    [
      "code-review",
      {
        meta: { name: "code-review", description: "Review code" },
        default: async () => "ok",
      },
    ],
  ]);
  const ctx = {
    hasUI: true,
    ui: {
      async select() {
        return "code-review — Review code";
      },
      async input() {
        return " review src ";
      },
      async editor() {
        return "";
      },
      async confirm() {
        confirmCalls++;
        throw new Error("inspector prompt should not be shown");
      },
    },
  } as unknown as ExtensionCommandContext;

  const invocation = await pickWorkflow(workflows, ctx);

  assert.equal(confirmCalls, 0);
  assert.deepEqual(invocation, { name: "code-review", args: "review src", options: {} });
});

test("pickWorkflow uses custom picker values instead of long raw select rows", async () => {
  let customCalls = 0;
  const workflows = new Map<string, WorkflowModule>([
    [
      "refactor-scout",
      {
        meta: {
          name: "refactor-scout",
          description:
            "Advisory-only refactor scout with a deliberately long description that would wrap in narrow terminal selectors.",
        },
        default: async () => "ok",
      },
    ],
  ]);
  const ctx = {
    hasUI: true,
    ui: {
      async custom() {
        customCalls++;
        return "refactor-scout";
      },
      async select() {
        throw new Error("raw select should not be used when custom picker is available");
      },
      async input() {
        return "";
      },
      async editor() {
        return "";
      },
    },
  } as unknown as ExtensionCommandContext;

  const invocation = await pickWorkflow(workflows, ctx);

  assert.equal(customCalls, 1);
  assert.deepEqual(invocation, { name: "refactor-scout", args: "", options: {} });
});

test("buildTemporaryWorkflowAuthorPrompt asks for an inline one-shot workflow", () => {
  const prompt = buildTemporaryWorkflowAuthorPrompt("inspect src and summarize risks");

  assert.match(prompt, /dynamax author and run a temporary one-shot inline workflow/);
  assert.match(prompt, /inspect src and summarize risks/);
  assert.match(prompt, /workflow tool with a script argument, not a saved workflow name/);
  assert.match(prompt, /Use the injected Type object/);
  assert.match(prompt, /Set thinkingLevel explicitly/);
  assert.match(prompt, /skills: \["skill-name"]/);
});
