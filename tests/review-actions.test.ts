import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { handleReviewViewerAction, type ReviewActionContext, type ReviewActionPi } from "../.pi/extensions/pi-workflow-engine/src/review/review-actions.ts";
import { buildFixHandoffPrompt } from "../.pi/extensions/pi-workflow-engine/src/review/review-handoff.ts";
import { toReviewIssues, type ReviewContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";

test("fix handoff prompt includes selected issue JSON", async () => {
  const issues = toReviewIssues("code-review", createReport());
  const context: ReviewContext = { workflowName: "code-review", target: "review src", diffCommand: "gh pr diff 123", files: ["src/app.ts"], summary: "PR 123" };
  const prompt = buildFixHandoffPrompt([issues[0]!], context);

  assert.match(prompt, /workflow-code-review-actions/);
  assert.match(prompt, /Mode: fix selected code-review findings/);
  assert.match(prompt, /"id":"R001"/);
  assert.match(prompt, /"file":"src\/app\.ts"/);
  assert.match(prompt, /"line":10/);
  assert.match(prompt, /minimal edits/);
  assert.match(prompt, /Preserve unrelated user changes/);
  assert.match(prompt, /focused validation/);
  assert.match(prompt, /Do not post GitHub PR comments/);

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

  await handleReviewViewerAction(pi, ctx, { action: "fix", issueIds: ["R001"] }, issues, context);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.deliverAs, "followUp");
  assert.match(sent[0]?.content ?? "", /"id":"R001"/);
  assert.deepEqual(notifications, ["Queued fix request for 1 selected finding(s)"]);
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

  await handleReviewViewerAction(pi, ctx, { action: "comment", issueIds: ["R001"] }, issues, context);

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
    ],
    nextSteps: ["Inspect src/app.ts retry loop"],
  };
}
