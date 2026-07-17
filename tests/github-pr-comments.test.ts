import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import {
  buildInlineCommentBody,
  postInlineComments,
  resolveGitHubPrContext,
  type ExecLike,
} from "../.pi/extensions/pi-workflow-engine/src/review/github-pr-comments.ts";
import { toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import type { ReviewContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-report.ts";

test("posts inline comments through gh api with path line and head sha", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string | undefined }> = [];
  const exec: ExecLike = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (args[0] === "pr" && args[1] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 123,
          headRefOid: "abc123sha",
          url: "https://github.com/acme/widgets/pull/123",
        }),
      };
    }
    if (args.includes("--paginate")) return { code: 0, stdout: "[[]]" };
    if (args[0] === "api") {
      return { code: 0, stdout: JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/123#discussion_r1" }) };
    }
    return { code: 1, stdout: "", stderr: `unexpected args ${args.join(" ")}` };
  };
  const reviewContext: ReviewContext = {
    workflowName: "code-review",
    target: "",
    diffTarget: { kind: "pull-request", number: 123 },
    files: ["src/app.ts"],
    summary: "PR 123",
  };

  const resolved = await resolveGitHubPrContext(exec, "/repo", reviewContext);
  if (!resolved.ok) throw new Error(resolved.reason);
  assert.deepEqual(resolved.context, {
    owner: "acme",
    repo: "widgets",
    number: 123,
    headSha: "abc123sha",
    url: "https://github.com/acme/widgets/pull/123",
  });

  const statuses = await postInlineComments(exec, "/repo", resolved.context, toReviewIssues("code-review", createReport()));
  assert.deepEqual(statuses, [{ issueId: "R001", status: "posted", url: "https://github.com/acme/widgets/pull/123#discussion_r1" }]);

  const apiCall = calls.find((call) => call.args.some((arg) => arg.startsWith("body=")));
  assert.ok(apiCall);
  assert.equal(apiCall.command, "gh");
  assert.equal(apiCall.cwd, "/repo");
  assert.equal(apiCall.args[1], "repos/acme/widgets/pulls/123/comments");
  assert.ok(apiCall.args.includes("commit_id=abc123sha"));
  assert.ok(apiCall.args.includes("path=src/app.ts"));
  assert.ok(apiCall.args.includes("line=10"));
  assert.ok(apiCall.args.includes("side=RIGHT"));
  assert.ok(apiCall.args.some((arg) => arg.startsWith("body=**R001: Off-by-one in retry loop.")));
});

test("posts forked PR inline comments to the base repository", async () => {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string | undefined }> = [];
  const exec: ExecLike = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (args[0] === "pr" && args[1] === "view") {
      return {
        code: 0,
        stdout: JSON.stringify({
          number: 456,
          headRefOid: "forkheadsha",
          url: "https://github.com/acme/widgets/pull/456",
          headRepositoryOwner: { login: "contributor" },
          headRepository: { name: "widgets-fork" },
        }),
      };
    }
    if (args.includes("--paginate")) return { code: 0, stdout: "[[]]" };
    if (args[0] === "api") {
      return { code: 0, stdout: JSON.stringify({ html_url: "https://github.com/acme/widgets/pull/456#discussion_r2" }) };
    }
    return { code: 1, stdout: "", stderr: `unexpected args ${args.join(" ")}` };
  };
  const reviewContext: ReviewContext = {
    workflowName: "code-review",
    target: "",
    diffTarget: { kind: "pull-request", number: 456 },
    files: ["src/app.ts"],
    summary: "PR 456",
  };

  const resolved = await resolveGitHubPrContext(exec, "/repo", reviewContext);
  if (!resolved.ok) throw new Error(resolved.reason);
  assert.deepEqual(resolved.context, {
    owner: "acme",
    repo: "widgets",
    number: 456,
    headSha: "forkheadsha",
    url: "https://github.com/acme/widgets/pull/456",
  });

  const statuses = await postInlineComments(exec, "/repo", resolved.context, toReviewIssues("code-review", createReport()));
  assert.deepEqual(statuses, [{ issueId: "R001", status: "posted", url: "https://github.com/acme/widgets/pull/456#discussion_r2" }]);

  const apiCall = calls.find((call) => call.args.some((arg) => arg.startsWith("body=")));
  assert.ok(apiCall);
  assert.equal(apiCall.args[1], "repos/acme/widgets/pulls/456/comments");
  assert.ok(apiCall.args.includes("commit_id=forkheadsha"));
});

test("skips an identical inline comment already present on the reviewed PR head", async () => {
  const issue = toReviewIssues("code-review", createReport())[0];
  if (!issue) throw new Error("expected review issue");
  let postCalls = 0;
  const exec: ExecLike = async (_command, args) => {
    if (args.includes("--paginate")) {
      return {
        code: 0,
        stdout: JSON.stringify([[
          { body: buildInlineCommentBody(issue), path: "src/app.ts", line: 10, commit_id: "reviewed-head" },
        ]]),
      };
    }
    postCalls++;
    return { code: 0, stdout: "{}" };
  };

  const statuses = await postInlineComments(
    exec,
    "/repo",
    { owner: "acme", repo: "widgets", number: 123, headSha: "reviewed-head" },
    [issue],
  );

  assert.equal(postCalls, 0);
  assert.deepEqual(statuses, [{ issueId: "R001", status: "skipped", reason: "An identical inline comment already exists on this PR head." }]);
});

test("passes abort signals to gh and stops before later comment writes", async () => {
  const report = createReport();
  report.findings.push({ ...report.findings[0]!, summary: "Second finding", locations: [{ file: "src/other.ts", line: 20 }] });
  const issues = toReviewIssues("code-review", report);
  const controller = new AbortController();
  let postCalls = 0;
  const exec: ExecLike = async (_command, args, options) => {
    assert.equal(options?.signal, controller.signal);
    if (args.includes("--paginate")) return { code: 0, stdout: "[[]]" };
    postCalls++;
    controller.abort(new Error("stop comment batch"));
    return { code: 0, stdout: "{}" };
  };

  await assert.rejects(
    () => postInlineComments(exec, "/repo", { owner: "acme", repo: "widgets", number: 123, headSha: "reviewed-head" }, issues, controller.signal),
    /stop comment batch/,
  );
  assert.equal(postCalls, 1);
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
