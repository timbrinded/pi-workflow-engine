import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  addWorktree,
  captureWorktreePatch,
  createWorktreePath,
  isGitWorktree,
  WorktreeRegistry,
  type WorktreeGitCommandOptions,
  type WorktreeGitCommandResult,
  type WorktreeGitRunner,
} from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";

function fakeRunner(
  handler: (options: WorktreeGitCommandOptions) => WorktreeGitCommandResult | Promise<WorktreeGitCommandResult>,
): WorktreeGitRunner & { readonly calls: WorktreeGitCommandOptions[] } {
  const calls: WorktreeGitCommandOptions[] = [];
  return {
    calls,
    async runGit(options) {
      calls.push(options);
      return await handler(options);
    },
  };
}

const OK: WorktreeGitCommandResult = { ok: true, stdout: "", stderr: "" };

test("createWorktreePath creates unique paths under the requested base dir", () => {
  const first = createWorktreePath("/tmp/pi-test");
  const second = createWorktreePath("/tmp/pi-test");

  assert.ok(first.startsWith("/tmp/pi-test/pi-workflow-"));
  assert.ok(second.startsWith("/tmp/pi-test/pi-workflow-"));
  assert.notEqual(first, second);
});

test("isGitWorktree probes the repository cwd", async () => {
  const runner = fakeRunner(() => ({ ok: true, stdout: "true\n", stderr: "" }));

  assert.equal(await isGitWorktree({ repoCwd: "/repo", runner }), true);
  assert.deepEqual(runner.calls.map((call) => ({ cwd: call.cwd, args: call.args })), [
    { cwd: "/repo", args: ["rev-parse", "--is-inside-work-tree"] },
  ]);

  const failing = fakeRunner(() => ({ ok: false, stdout: "", stderr: "no git", error: "no git" }));
  assert.equal(await isGitWorktree({ repoCwd: "/repo", runner: failing }), false);
});

test("addWorktree builds a detached HEAD worktree command", async () => {
  const runner = fakeRunner(() => OK);
  const result = await addWorktree({ repoCwd: "/repo", runner, baseDir: "/tmp/pi-test" });

  assert.ok(!("error" in result));
  assert.ok(result.path.startsWith("/tmp/pi-test/pi-workflow-"));
  assert.deepEqual(runner.calls[0]?.cwd, "/repo");
  assert.deepEqual(runner.calls[0]?.args.slice(0, 4), ["worktree", "add", "--detach", result.path]);
  assert.equal(runner.calls[0]?.args[4], "HEAD");
});

test("WorktreeRegistry registers created worktrees and removes them", async () => {
  const runner = fakeRunner(() => OK);
  const registry = new WorktreeRegistry("/repo", { runner });

  const added = await registry.add();
  assert.ok(!("error" in added));
  assert.equal(registry.size, 1);

  await registry.remove(added.path);
  assert.equal(registry.size, 0);
  assert.deepEqual(runner.calls.map((call) => call.args[0]), ["worktree", "worktree"]);
  assert.deepEqual(runner.calls[1]?.args, ["worktree", "remove", "--force", added.path]);
});

test("WorktreeRegistry removeAll retries every registered path", async () => {
  const removed: string[] = [];
  const runner = fakeRunner((options) => {
    removed.push(String(options.args[3]));
    return OK;
  });
  const registry = new WorktreeRegistry("/repo", { runner });
  registry.register("/tmp/one");
  registry.register("/tmp/two");

  await registry.removeAll();

  assert.deepEqual(removed.sort(), ["/tmp/one", "/tmp/two"]);
  assert.equal(registry.size, 0);
});

test("WorktreeRegistry can use an injected patch capture", async () => {
  const registry = new WorktreeRegistry("/repo", {
    runner: fakeRunner(() => OK),
    patchCapture: async ({ worktreePath }) => ({ patch: `diff for ${worktreePath}`, changed: true }),
  });

  assert.deepEqual(await registry.capturePatch("/tmp/worktree"), { patch: "diff for /tmp/worktree", changed: true });
});

test("captureWorktreePatch reports git add failures before diff capture", async () => {
  const runner = fakeRunner(() => ({ ok: false, stdout: "", stderr: "add failed", error: "add failed" }));

  assert.deepEqual(await captureWorktreePatch({ worktreePath: "/tmp/worktree", runner }), { error: "add failed" });
  assert.deepEqual(runner.calls.map((call) => call.args), [["add", "-N", "."]]);
});
