import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { handleReviewViewerAction, type ReviewActionContext, type ReviewActionPi } from "../.pi/extensions/pi-workflow-engine/src/review/review-actions.ts";
import {
  buildFixAgentPrompt,
  captureReviewMaterial,
  resolveReviewWorktreeBaseline,
  runReviewFixWorkflow,
  type ReviewFixWorkflowApi,
} from "../.pi/extensions/pi-workflow-engine/src/review/review-fix-workflow.ts";
import { toReviewIssues, type ReviewContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";

test("fix action returns a programmatic workflow instead of a parent follow-up", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "review src", diffCommand: "gh pr diff 123", files: ["src/app.ts"], summary: "PR 123" };
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

  const request = await handleReviewViewerAction(pi, ctx, { action: "fix", issueIds: ["R001"] }, issues, context);

  assert.equal(sent.length, 0);
  assert.equal(request?.kind, "run-workflow");
  assert.equal(request?.module.meta.name, "code-review-fix-previews");
  assert.deepEqual(request?.module.source, {
    kind: "file",
    path: fileURLToPath(new URL("../.pi/extensions/pi-workflow-engine/src/review/review-fix-workflow.ts", import.meta.url)),
  });
  assert.equal(request?.args, "");
  assert.deepEqual(notifications, ["Generating isolated patch previews for 1 selected finding(s)"]);
});

test("fix workflow keeps finding ids, isolated patches, and per-finding failures", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "review src", diffCommand: "gh pr diff 123", files: ["src/app.ts", "src/lock.ts"] };
  const calls: Array<{ prompt: string; options: Parameters<ReviewFixWorkflowApi["agent"]>[1] }> = [];
  const phases: string[] = [];
  const api: ReviewFixWorkflowApi = {
    parallel: bindParallel({}),
    phase(title) {
      phases.push(title);
    },
    cwd: "/repo",
    signal: undefined,
    async agent(prompt, options) {
      calls.push({ prompt, options });
      if (options.label === "fix:R002") throw new Error("validation environment unavailable");
      return {
        result: "Updated src/app.ts and ran bun test tests/retry.test.ts (passed).",
        patch: "diff --git a/src/app.ts b/src/app.ts\n+fixed\n",
        changed: true,
      };
    },
  };

  const baseline = { ref: "0123456789012345678901234567890123456789" };
  const result = await runReviewFixWorkflow(api, issues, context, async () => baseline);

  assert.deepEqual(phases, ["Generate patch previews"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.options.isolation, "worktree");
  assert.deepEqual(calls[0]?.options.worktreeBaseline, baseline);
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

test("review fix baseline revalidates and reconstructs a dirty working-tree snapshot", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-baseline-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "export const value = 1;\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    await writeFile(join(repo, "app.ts"), "export const value = 2;\n");
    const material = await captureReviewMaterial("git diff", repo);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "dirty worktree",
      diffCommand: "git diff",
      files: ["app.ts"],
      diffFingerprint: material.diffFingerprint,
      baselineFingerprint: material.baselineFingerprint,
    };

    const baseline = await resolveReviewWorktreeBaseline(context, repo);

    assert.equal(baseline.ref, head);
    assert.match(baseline.patch ?? "", /\+export const value = 2/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review fix baseline rejects a diff that changed after review", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-stale-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    await writeFile(join(repo, "app.ts"), "after\n");
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "dirty worktree",
      diffCommand: "git diff",
      files: ["app.ts"],
      diffFingerprint: createHash("sha256").update("different diff").digest("hex"),
      baselineFingerprint: createHash("sha256").update("different baseline").digest("hex"),
    };

    await assert.rejects(() => resolveReviewWorktreeBaseline(context, repo), /reviewed diff changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review fix baseline resolves a ref-range target to its immutable commit", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-range-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    await writeFile(join(repo, "app.ts"), "reviewed\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "reviewed"], { cwd: repo }).status,
      0,
    );
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const material = await captureReviewMaterial("git diff HEAD~1...HEAD", repo);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "HEAD~1...HEAD",
      diffCommand: "git diff HEAD~1...HEAD",
      files: ["app.ts"],
      diffFingerprint: material.diffFingerprint,
      baselineFingerprint: material.baselineFingerprint,
    };

    assert.deepEqual(await resolveReviewWorktreeBaseline(context, repo), { ref: head });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review fix baseline rejects unchanged scoped diff when unrelated reviewed state changes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-baseline-state-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "before\n");
    await writeFile(join(repo, "other.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts", "other.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    await writeFile(join(repo, "app.ts"), "reviewed\n");
    const material = await captureReviewMaterial("git diff -- app.ts", repo);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "app.ts",
      diffCommand: "git diff -- app.ts",
      files: ["app.ts"],
      diffFingerprint: material.diffFingerprint,
      baselineFingerprint: material.baselineFingerprint,
    };

    await writeFile(join(repo, "other.ts"), "new unrelated staged state\n");
    assert.equal(spawnSync("git", ["add", "other.ts"], { cwd: repo }).status, 0);

    await assert.rejects(() => resolveReviewWorktreeBaseline(context, repo), /reviewed snapshot changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("cached review baseline represents the index and excludes later unstaged content", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-index-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    await writeFile(join(repo, "app.ts"), "reviewed index\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    const material = await captureReviewMaterial("git diff --cached", repo);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "index",
      diffCommand: "git diff --cached",
      files: ["app.ts"],
      diffFingerprint: material.diffFingerprint,
      baselineFingerprint: material.baselineFingerprint,
    };
    await writeFile(join(repo, "app.ts"), "later unstaged content\n");

    const baseline = await resolveReviewWorktreeBaseline(context, repo);

    assert.match(baseline.patch ?? "", /\+reviewed index/);
    assert.doesNotMatch(baseline.patch ?? "", /later unstaged content/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review baseline treats valid file operands as working-tree paths, not commit refs", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-path-operands-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "README.md"), "before readme\n");
    await writeFile(join(repo, "USAGE.md"), "before usage\n");
    assert.equal(spawnSync("git", ["add", "README.md", "USAGE.md"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    await writeFile(join(repo, "README.md"), "reviewed readme\n");
    await writeFile(join(repo, "USAGE.md"), "reviewed usage\n");

    const paths = await captureReviewMaterial("git diff README.md USAGE.md", repo);
    const refAndPath = await captureReviewMaterial("git diff HEAD README.md", repo);

    assert.equal(paths.baseline.ref, head);
    assert.match(paths.baseline.patch ?? "", /reviewed readme/);
    assert.match(paths.baseline.patch ?? "", /reviewed usage/);
    assert.equal(refAndPath.baseline.ref, head);
    assert.match(refAndPath.diff, /reviewed readme/);
    assert.doesNotMatch(refAndPath.diff, /reviewed usage/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("comment action falls back to parent agent when gh context is unavailable", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "", diffCommand: "git diff main...HEAD", files: ["src/app.ts"], summary: "No PR context" };
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
  const ctx: ReviewActionContext = {
    cwd: "/repo",
    ui: {
      async confirm(title, message) {
        assert.equal(title, "Post inline PR comments?");
        assert.match(message, /Post 1 selected finding\(s\)/);
        return true;
      },
      notify(message) {
        notifications.push(message);
      },
    },
  };

  const request = await handleReviewViewerAction(pi, ctx, { action: "comment", issueIds: ["R001"] }, issues, context);

  assert.equal(request, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.deliverAs, "followUp");
  assert.match(sent[0]?.content ?? "", /Mode: post inline GitHub PR comments/);
  assert.match(sent[0]?.content ?? "", /Prefer installed GitHub MCP\/tools/);
  assert.match(sent[0]?.content ?? "", /otherwise use the GitHub CLI \(gh\)/);
  assert.match(sent[0]?.content ?? "", /Do not edit files/);
  assert.match(sent[0]?.content ?? "", /"id":"R001"/);
  assert.deepEqual(notifications, ["Queued PR comment request for 1 selected finding(s)"]);
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
