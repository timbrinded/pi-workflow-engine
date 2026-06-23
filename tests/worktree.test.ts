import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  captureWorktreePatch,
  createWorktreePath,
  isGitWorktree,
  removeWorktree,
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

  assert.deepEqual(await isGitWorktree({ repoCwd: "/repo", runner }), { ok: true, inside: true });
  assert.deepEqual(runner.calls.map((call) => ({ cwd: call.cwd, args: call.args })), [
    { cwd: "/repo", args: ["rev-parse", "--is-inside-work-tree"] },
  ]);

  const outside = fakeRunner(() => ({ ok: true, stdout: "false\n", stderr: "" }));
  assert.deepEqual(await isGitWorktree({ repoCwd: "/repo", runner: outside }), { ok: true, inside: false });

  const failing = fakeRunner(() => ({ ok: false, stdout: "", stderr: "no git", error: "no git" }));
  assert.deepEqual(await isGitWorktree({ repoCwd: "/repo", runner: failing }), { ok: false, inside: false, error: "no git" });
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

test("WorktreeRegistry attempts cleanup when worktree add fails", async () => {
  const runner = fakeRunner((options) => {
    if (options.args[0] === "worktree" && options.args[1] === "add") {
      return { ok: false, stdout: "", stderr: "add failed", error: "add failed" };
    }
    return OK;
  });
  const registry = new WorktreeRegistry("/repo", { runner });

  const added = await registry.add();

  assert.ok("error" in added);
  assert.equal(added.error, "add failed");
  assert.equal(added.cleanup?.ok, true);
  assert.equal(registry.size, 0);
  assert.deepEqual(runner.calls.map((call) => call.args.slice(0, 2).join(" ")), ["worktree add", "worktree remove"]);
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

  const outcomes = await registry.removeAll();

  assert.deepEqual(removed.sort(), ["/tmp/one", "/tmp/two"]);
  assert.deepEqual(outcomes.map((outcome) => ({ path: outcome.path, ok: outcome.ok })).sort((a, b) => a.path.localeCompare(b.path)), [
    { path: "/tmp/one", ok: true },
    { path: "/tmp/two", ok: true },
  ]);
  assert.equal(registry.size, 0);
});

test("WorktreeRegistry removeAll reports failed removals without throwing", async () => {
  const runner = fakeRunner((options) => {
    if (options.args[3] === "/tmp/leaked") return { ok: false, stdout: "", stderr: "busy", error: "busy" };
    return OK;
  });
  const registry = new WorktreeRegistry("/repo", { runner });
  registry.register("/tmp/leaked");

  const outcomes = await registry.removeAll();

  assert.deepEqual(outcomes.map((outcome) => ({ path: outcome.path, ok: outcome.ok, error: outcome.error })), [
    { path: "/tmp/leaked", ok: false, error: "busy" },
  ]);
  assert.equal(registry.size, 1);
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

test("captureWorktreePatch captures diff through the injected git runner", async () => {
  const runner = fakeRunner((options) => {
    if (options.args[0] === "diff") return { ok: true, stdout: "diff --git a/file b/file\n+change\n", stderr: "" };
    return OK;
  });

  assert.deepEqual(await captureWorktreePatch({ worktreePath: "/tmp/worktree", runner }), {
    patch: "diff --git a/file b/file\n+change\n",
    changed: true,
  });
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["add", "-N", "."],
    ["diff", "--no-color", "HEAD"],
  ]);
  assert.equal(runner.calls[1]?.maxBufferBytes, 16 << 20);
});

async function makeTempGitRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  const init = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return repo;
}

test("addWorktree falls back to a committed snapshot for unborn repositories", async () => {
  const repo = await makeTempGitRepo("pi-workflow-unborn-");
  await writeFile(join(repo, "README.md"), "hello\n");
  let added: Awaited<ReturnType<typeof addWorktree>> | undefined;
  try {
    added = await addWorktree({ repoCwd: repo });
    assert.ok(!("error" in added), "addWorktree should succeed via snapshot fallback");
    assert.equal(added.snapshot, true);

    await writeFile(join(added.path, "route.txt"), "generated\n");
    const patch = await captureWorktreePatch({ worktreePath: added.path });
    assert.ok(!("error" in patch), "patch capture should work in fallback snapshot");
    assert.equal(patch.changed, true);
    assert.match(patch.patch, /diff --git a\/route\.txt b\/route\.txt/);
    assert.match(patch.patch, /\+generated/);
  } finally {
    if (added && !("error" in added)) await removeWorktree({ repoCwd: repo, path: added.path, snapshot: added.snapshot });
    await rm(repo, { recursive: true, force: true });
  }
});

test("addWorktree uses real git worktrees for repositories with commits", async () => {
  const repo = await makeTempGitRepo("pi-workflow-committed-");
  let added: Awaited<ReturnType<typeof addWorktree>> | undefined;
  try {
    await writeFile(join(repo, "README.md"), "hello\n");
    assert.equal(spawnSync("git", ["add", "README.md"], { cwd: repo }).status, 0);
    const commit = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(commit.status, 0, commit.stderr);

    added = await addWorktree({ repoCwd: repo });
    assert.ok(!("error" in added));
    assert.notEqual(added.snapshot, true);
    await writeFile(join(added.path, "committed.txt"), "changed\n");
    const patch = await captureWorktreePatch({ worktreePath: added.path });
    assert.ok(!("error" in patch));
    assert.match(patch.patch, /diff --git a\/committed\.txt b\/committed\.txt/);
  } finally {
    if (added && !("error" in added)) await removeWorktree({ repoCwd: repo, path: added.path, snapshot: added.snapshot });
    await rm(repo, { recursive: true, force: true });
  }
});
