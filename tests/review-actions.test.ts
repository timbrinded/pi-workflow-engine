import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { parseAllowedDiffCommand, type ReviewDiffTarget } from "../.pi/extensions/pi-workflow-engine/src/review-diff-target.ts";
import type { AgentOptions } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { handleReviewViewerAction, type ReviewActionContext, type ReviewActionPi } from "../.pi/extensions/pi-workflow-engine/src/review/review-actions.ts";
import {
  buildFixAgentPrompt,
  runReviewFixWorkflow,
  type ReviewFixWorkflowApi,
} from "../.pi/extensions/pi-workflow-engine/src/review/review-fix-workflow.ts";
import { toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import type { ReviewContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-report.ts";
import { ReviewSnapshotUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/review/review-snapshot.ts";

function reviewTarget(command: string): ReviewDiffTarget {
  const parsed = parseAllowedDiffCommand(command);
  if ("error" in parsed) assert.fail(parsed.error);
  return parsed;
}

function prReviewContext(number = 123): ReviewContext {
  return {
    workflowName: "code-review",
    target: "",
    diffTarget: reviewTarget(`gh pr diff ${number}`),
    files: ["src/app.ts"],
  };
}

test("fix action returns a programmatic workflow instead of a parent follow-up", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "review src", diffTarget: reviewTarget("gh pr diff 123"), files: ["src/app.ts"], summary: "PR 123" };
  const prompt = buildFixAgentPrompt(issues[0]!, context);

  assert.match(prompt, /exactly one verified code-review finding/);
  assert.match(prompt, /"id":"R001"/);
  assert.match(prompt, /"file":"src\/app\.ts"/);
  assert.match(prompt, /"line":10/);
  assert.match(prompt, /line 10 increments before checking the limit/);
  assert.doesNotMatch(prompt, /R002/);
  assert.match(prompt, /smallest edit/);
  assert.match(prompt, /Preserve unrelated user changes/);
  assert.match(prompt, /focused validation/);
  assert.match(prompt, /captures your worktree diff automatically/);
  assert.match(prompt, /Do not post GitHub PR comments/);
  assert.match(prompt, /validation results/);

  const sent: Array<{ content: string; deliverAs: string | undefined }> = [];
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage(content, options) {
      sent.push({ content: typeof content === "string" ? content : "non-text", deliverAs: options?.deliverAs });
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "not used", killed: false };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  const baseline = { ref: "0123456789012345678901234567890123456789" };
  const request = await handleReviewViewerAction(
    pi,
    ctx,
    { action: "fix", issueIds: ["R001"] },
    issues,
    context,
    async (receivedContext, cwd, signal) => {
      assert.equal(receivedContext, context);
      assert.equal(cwd, "/repo");
      assert.equal(signal, undefined);
      return baseline;
    },
  );

  assert.equal(sent.length, 0);
  assert.equal(request?.meta.name, "code-review-fix-previews");
  assert.deepEqual(request?.source, {
    kind: "unverifiable",
    reason: "ephemeral review-fix workflows capture runtime findings and do not have immutable module provenance",
  });
  assert.deepEqual(request?.isolatedWorktreeBaseline, baseline);
  assert.deepEqual(notifications, [
    "Verifying the reviewed snapshot before generating patch previews",
    "Generating isolated patch previews for 1 selected finding(s)",
  ]);
});

test("fix action propagates cancellation raised during snapshot resolution", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const controller = new AbortController();
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage() {},
    async exec() {
      return { code: 1, stdout: "", stderr: "not used", killed: false };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    signal: controller.signal,
    ui: {
      async confirm() {
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  await assert.rejects(
    () =>
      handleReviewViewerAction(
        pi,
        ctx,
        { action: "fix", issueIds: ["R001"] },
        issues,
        undefined,
        async () => {
          controller.abort(new WorkflowAbortError("review action cancelled"));
          throw new Error("snapshot resolver failed after abort");
        },
      ),
    /review action cancelled/,
  );
  assert.deepEqual(notifications, ["Verifying the reviewed snapshot before generating patch previews"]);
});

test("fix workflow keeps finding ids, isolated patches, and per-finding failures", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "review src", diffTarget: reviewTarget("gh pr diff 123"), files: ["src/app.ts", "src/lock.ts"] };
  type ReviewFixAgentOptions = AgentOptions & { readonly isolation: "worktree" };
  const calls: Array<{ prompt: string; options: ReviewFixAgentOptions }> = [];
  const phases: string[] = [];
  const parallel = bindParallel({});
  let parallelRead = false;
  const agent = async (prompt: string, options: ReviewFixAgentOptions) => {
    calls.push({ prompt, options });
    if (options.label === "fix:R002") throw new Error("validation environment unavailable");
    return {
      result: "Updated src/app.ts and ran bun test tests/retry.test.ts (passed).",
      patch: "diff --git a/src/app.ts b/src/app.ts\n+fixed\n",
      changed: true,
    };
  };
  const api: ReviewFixWorkflowApi = {
    get parallel() {
      parallelRead = true;
      return parallel;
    },
    phase(title) {
      phases.push(title);
    },
    agent: agent as ReviewFixWorkflowApi["agent"],
  };

  const result = await runReviewFixWorkflow(api, issues, context);

  assert.deepEqual(phases, ["Generate patch previews"]);
  assert.equal(parallelRead, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options.isolation, "worktree");
  assert.equal(calls[0]?.options.label, "fix:R001");
  assert.equal(calls[0]?.options.phase, "Generate patch previews");
  assert.equal(calls[0]?.options.thinkingLevel, "medium");
  assert.ok(calls[0]?.options.tools?.includes("edit"));
  assert.ok(calls[0]?.options.tools?.includes("write"));
  assert.deepEqual(calls[0]?.options.toolHints, ["search"]);
  assert.match(calls[0]?.prompt ?? "", /"id":"R001"/);
  assert.match(calls[1]?.prompt ?? "", /"id":"R002"/);

  assert.equal(result.fixes.length, 2);
  assert.deepEqual(result.fixes[0], {
    findingId: "R001",
    result: "Updated src/app.ts and ran bun test tests/retry.test.ts (passed).",
    patch: "diff --git a/src/app.ts b/src/app.ts\n+fixed\n",
    changed: true,
  });
  assert.deepEqual(result.fixes[1], {
    findingId: "R002",
    error: { name: "Error", message: "validation environment unavailable" },
  });
  assert.match(result.summary, /Generated 1 patch preview\(s\)/);
  assert.match(result.summary, /1 attempt\(s\) failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("comment action falls back to parent agent when gh context is unavailable", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { ...prReviewContext(), summary: "PR context unavailable" };
  const sent: Array<{ content: string; deliverAs: string | undefined }> = [];
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage(content, options) {
      sent.push({ content: typeof content === "string" ? content : "non-text", deliverAs: options?.deliverAs });
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "no pull request found", killed: false };
    },
  };
  let confirmations = 0;
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm(title, message) {
        confirmations++;
        if (confirmations === 1) {
          assert.equal(title, "Post inline PR comments?");
          assert.match(message, /Post 1 selected finding\(s\)/);
        } else {
          assert.equal(title, "Queue PR comment fallback?");
          assert.match(message, /Queue 1 finding\(s\)/);
        }
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  const request = await handleReviewViewerAction(
    pi,
    ctx,
    { action: "comment", issueIds: ["R001"] },
    issues,
    context,
    async () => ({ ref: "0123456789012345678901234567890123456789" }),
  );

  assert.equal(request, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.deliverAs, "followUp");
  assert.match(sent[0]?.content ?? "", /Mode: post inline GitHub PR comments/);
  assert.match(sent[0]?.content ?? "", /Prefer installed GitHub MCP\/tools/);
  assert.match(sent[0]?.content ?? "", /otherwise use the GitHub CLI \(gh\)/);
  assert.match(sent[0]?.content ?? "", /Do not edit files/);
  assert.match(sent[0]?.content ?? "", /"id":"R001"/);
  assert.match(sent[0]?.content ?? "", /verified reviewed head `0123456789012345678901234567890123456789`/);
  assert.equal(confirmations, 2);
  assert.deepEqual(notifications, [
    "Verifying the reviewed snapshot before posting PR comments",
    "Queued PR comment request for 1 selected finding(s)",
  ]);
});

test("comment action rejects mutable and local git review targets", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const notifications: string[] = [];
  let confirmations = 0;
  let resolverCalls = 0;
  const pi: ReviewActionPi = {
    sendUserMessage() {
      throw new Error("fallback must not be queued");
    },
    async exec() {
      throw new Error("GitHub must not be called");
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        confirmations++;
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  for (const command of ["git diff", "git diff --cached", "git diff main...HEAD"]) {
    const diffTarget = reviewTarget(command);
    await handleReviewViewerAction(
      pi,
      ctx,
      { action: "comment", issueIds: ["R001"] },
      issues,
      {
        workflowName: "code-review",
        target: "",
        diffTarget,
        files: ["src/app.ts"],
      },
      async () => {
        resolverCalls++;
        return { ref: "0123456789012345678901234567890123456789" };
      },
    );
  }

  assert.equal(confirmations, 0);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(notifications, [
    "PR comments are available only for findings captured from a verified pull-request diff.",
    "PR comments are available only for findings captured from a verified pull-request diff.",
    "PR comments are available only for findings captured from a verified pull-request diff.",
  ]);
});

test("comment fallback does not queue after cancellation during confirmation", async () => {
  const controller = new AbortController();
  const issues = toReviewIssues("code-review", createReport());
  const sent: string[] = [];
  let confirmations = 0;
  const pi: ReviewActionPi = {
    sendUserMessage(content) {
      sent.push(typeof content === "string" ? content : "non-text");
    },
    async exec() {
      return { code: 1, stdout: "", stderr: "no pull request found", killed: false };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    signal: controller.signal,
    ui: {
      async confirm() {
        confirmations++;
        if (confirmations === 2) controller.abort(new Error("cancel fallback"));
        return true;
      },
      notify() {},
    },
  };

  await assert.rejects(
    () =>
      handleReviewViewerAction(
        pi,
        ctx,
        { action: "comment", issueIds: ["R001"] },
        issues,
        prReviewContext(),
        async () => ({ ref: "0123456789012345678901234567890123456789" }),
      ),
    /cancel fallback/,
  );
  assert.deepEqual(sent, []);
});

test("comment action refuses stale findings after confirmation and before posting or fallback", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const sent: string[] = [];
  let confirmations = 0;
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage(content) {
      sent.push(typeof content === "string" ? content : "non-text");
    },
    async exec() {
      throw new Error("GitHub must not be called for stale findings");
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        confirmations++;
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  await handleReviewViewerAction(
    pi,
    ctx,
    { action: "comment", issueIds: ["R001"] },
    issues,
    prReviewContext(),
    async () => {
      throw new ReviewSnapshotUnavailableError("the reviewed diff changed after the findings were generated.");
    },
  );

  assert.equal(confirmations, 1);
  assert.deepEqual(sent, []);
  assert.deepEqual(notifications, [
    "Verifying the reviewed snapshot before posting PR comments",
    "PR comments unavailable because the reviewed diff changed after the findings were generated.",
  ]);
});

test("declining comment confirmation cancels without posting or fallback", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const sent: string[] = [];
  let execCalls = 0;
  let resolverCalls = 0;
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage(content) {
      sent.push(typeof content === "string" ? content : "non-text");
    },
    async exec() {
      execCalls++;
      return { code: 1, stdout: "", stderr: "not used", killed: false };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        return false;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  await handleReviewViewerAction(
    pi,
    ctx,
    { action: "comment", issueIds: ["R001"] },
    issues,
    prReviewContext(),
    async () => {
      resolverCalls++;
      return { ref: "0123456789012345678901234567890123456789" };
    },
  );

  assert.equal(execCalls, 0);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(sent, []);
  assert.deepEqual(notifications, ["PR comment posting cancelled"]);
});

test("comment action refuses a PR head that differs from the verified snapshot", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const sent: string[] = [];
  const calls: string[][] = [];
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage(content) {
      sent.push(typeof content === "string" ? content : "non-text");
    },
    async exec(_command, args) {
      calls.push(args);
      return {
        code: 0,
        stdout: JSON.stringify({ number: 123, headRefOid: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", url: "https://github.com/acme/widgets/pull/123" }),
        stderr: "",
        killed: false,
      };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  await handleReviewViewerAction(
    pi,
    ctx,
    { action: "comment", issueIds: ["R001"] },
    issues,
    prReviewContext(),
    async () => ({ ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.[0], "pr");
  assert.deepEqual(sent, []);
  assert.deepEqual(notifications, [
    "Verifying the reviewed snapshot before posting PR comments",
    "PR comments unavailable because the pull request head changed after snapshot verification.",
  ]);
});

test("comment action posts only when the resolved PR head matches the verified snapshot", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const calls: string[][] = [];
  const notifications: string[] = [];
  const pi: ReviewActionPi = {
    sendUserMessage() {
      throw new Error("fallback must not run when direct posting succeeds");
    },
    async exec(_command, args) {
      calls.push(args);
      if (args[0] === "pr") {
        return {
          code: 0,
          stdout: JSON.stringify({ number: 123, headRefOid: head, url: "https://github.com/acme/widgets/pull/123" }),
          stderr: "",
          killed: false,
        };
      }
      if (args.includes("--paginate")) return { code: 0, stdout: "[[]]", stderr: "", killed: false };
      return { code: 0, stdout: JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/123#discussion_r1" }), stderr: "", killed: false };
    },
  };
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm() {
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  await handleReviewViewerAction(
    pi,
    ctx,
    { action: "comment", issueIds: ["R001"] },
    issues,
    prReviewContext(),
    async () => ({ ref: head }),
  );

  assert.equal(calls.filter((args) => args.some((arg) => arg.startsWith("body="))).length, 1);
  assert.deepEqual(notifications, [
    "Verifying the reviewed snapshot before posting PR comments",
    "PR comments: 1 posted, 0 skipped, 0 failed",
  ]);
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
      {
        summary: "Lock release is skipped on the error path.",
        category: "bug",
        severity: "high",
        confidence: "high",
        locations: [{ file: "src/lock.ts", line: 42, symbol: "release" }],
        evidence: ["the early return bypasses release()"],
        impact: "Later work can deadlock.",
        recommendation: "Release the lock in a finally block and add an error-path test.",
      },
    ],
    nextSteps: ["Inspect src/app.ts retry loop"],
  };
}
