import assert from "node:assert/strict";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWorktree,
  captureWorktreePatch,
  createWorktreePath,
  isGitWorktree,
  removeWorktree,
  validateWorktreePatch,
  WorktreeCleanupError,
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
const BASELINE_OID = "a".repeat(40);

function successfulWorktreeCommand(options: WorktreeGitCommandOptions): WorktreeGitCommandResult {
  return options.args[0] === "rev-parse"
    ? { ok: true, stdout: `${BASELINE_OID}\n`, stderr: "" }
    : OK;
}

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
  const runner = fakeRunner(successfulWorktreeCommand);
  const result = await addWorktree({ repoCwd: "/repo", runner, baseDir: "/tmp/pi-test" });

  assert.ok(!("error" in result));
  assert.ok(result.path.startsWith("/tmp/pi-test/pi-workflow-"));
  assert.deepEqual(runner.calls[0]?.cwd, "/repo");
  assert.deepEqual(runner.calls[0]?.args.slice(0, 4), ["worktree", "add", "--detach", result.path]);
  assert.equal(runner.calls[0]?.args[4], "HEAD");
  assert.equal(result.baselineOid, BASELINE_OID);
  assert.deepEqual(runner.calls[1]?.args, ["rev-parse", "--verify", "HEAD^{commit}"]);
});

test("addWorktree prepares and commits a supplied reviewed-snapshot patch", async () => {
  const runner = fakeRunner(successfulWorktreeCommand);
  const patch = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-before\n+reviewed\n";
  const result = await addWorktree({
    repoCwd: "/repo",
    runner,
    baseDir: "/tmp/pi-test",
    baseline: { ref: "review-head", patch },
  });

  assert.ok(!("error" in result));
  assert.equal(runner.calls[0]?.args[4], "review-head");
  assert.deepEqual(runner.calls[1]?.args, ["apply", "--index", "--binary", "--whitespace=nowarn", "-"]);
  assert.equal(runner.calls[1]?.stdin, patch);
  assert.ok(runner.calls[2]?.args.includes("commit"));
  assert.ok(runner.calls[2]?.args.includes("commit.gpgSign=false"));
  const hooksPath = runner.calls[2]?.args.find((arg) => arg.startsWith("core.hooksPath="));
  assert.ok(hooksPath);
  assert.equal(hooksPath.includes(result.path), false);
  assert.ok(runner.calls[2]?.args.includes("--no-verify"));
  assert.ok(runner.calls[2]?.args.includes("--no-gpg-sign"));
  assert.equal(result.baselineOid, BASELINE_OID);
  assert.deepEqual(runner.calls[3]?.args, ["rev-parse", "--verify", "HEAD^{commit}"]);
});

test("WorktreeRegistry registers created worktrees and removes them", async () => {
  const runner = fakeRunner(successfulWorktreeCommand);
  const registry = new WorktreeRegistry("/repo", { runner });

  const added = await registry.add();
  assert.ok(!("error" in added));
  assert.equal(registry.size, 1);

  await registry.remove(added.path);
  assert.equal(registry.size, 0);
  assert.deepEqual(runner.calls.map((call) => call.args[0]), ["worktree", "rev-parse", "worktree"]);
  assert.deepEqual(runner.calls[2]?.args, ["worktree", "remove", "--force", added.path]);
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

test("WorktreeRegistry coalesces concurrent removal of the same path", async () => {
  let releaseRemoval: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseRemoval = resolve;
  });
  const runner = fakeRunner(async () => {
    await gate;
    return OK;
  });
  const registry = new WorktreeRegistry("/repo", { runner });
  registry.register("/tmp/shared");

  const first = registry.remove("/tmp/shared");
  const second = registry.remove("/tmp/shared");
  assert.equal(runner.calls.length, 1);
  releaseRemoval?.();

  assert.deepEqual(await first, OK);
  assert.deepEqual(await second, OK);
  assert.equal(runner.calls.length, 1);
  assert.equal(registry.size, 0);
});

test("WorktreeRegistry removeAll tries every path, retains failures, and throws their aggregate", async () => {
  const removed: string[] = [];
  const runner = fakeRunner((options) => {
    const path = String(options.args[3]);
    removed.push(path);
    if (path === "/tmp/leaked-one") return { ok: false, stdout: "", stderr: "", error: "busy" };
    if (path === "/tmp/leaked-two") return { ok: false, stdout: "", stderr: "permission denied" };
    return OK;
  });
  const registry = new WorktreeRegistry("/repo", { runner });
  registry.register("/tmp/leaked-one");
  registry.register("/tmp/cleaned");
  registry.register("/tmp/leaked-two");
  let thrown: unknown;

  try {
    await registry.removeAll();
  } catch (error) {
    thrown = error;
  }

  assert.deepEqual(removed.sort(), ["/tmp/cleaned", "/tmp/leaked-one", "/tmp/leaked-two"]);
  assert.ok(thrown instanceof WorktreeCleanupError);
  assert.deepEqual(thrown.outcomes.map((outcome) => ({ path: outcome.path, ok: outcome.ok })), [
    { path: "/tmp/leaked-one", ok: false },
    { path: "/tmp/cleaned", ok: true },
    { path: "/tmp/leaked-two", ok: false },
  ]);
  assert.equal(thrown.errors.length, 2);
  assert.match(thrown.message, /\/tmp\/leaked-one \(busy\), \/tmp\/leaked-two \(permission denied\)/);
  assert.equal(registry.size, 2);

  removed.length = 0;
  await assert.rejects(registry.removeAll(), WorktreeCleanupError);
  assert.deepEqual(removed.sort(), ["/tmp/leaked-one", "/tmp/leaked-two"]);
});

test("WorktreeRegistry can use an injected patch capture", async () => {
  let capturedBaseline = "";
  const registry = new WorktreeRegistry("/repo", {
    runner: fakeRunner(() => OK),
    patchCapture: async ({ worktreePath, baselineOid }) => {
      capturedBaseline = baselineOid;
      return { patch: `diff for ${worktreePath}`, changed: true };
    },
  });

  assert.deepEqual(await registry.capturePatch("/tmp/worktree", BASELINE_OID), {
    patch: "diff for /tmp/worktree",
    changed: true,
  });
  assert.equal(capturedBaseline, BASELINE_OID);
});

test("captureWorktreePatch reports git add failures before diff capture", async () => {
  const runner = fakeRunner(() => ({ ok: false, stdout: "", stderr: "add failed", error: "add failed" }));

  assert.deepEqual(await captureWorktreePatch({ worktreePath: "/tmp/worktree", baselineOid: BASELINE_OID, runner }), {
    error: "add failed",
  });
  assert.deepEqual(runner.calls.map((call) => call.args), [["add", "-N", "."]]);
});

test("captureWorktreePatch captures diff through the injected git runner", async () => {
  const runner = fakeRunner((options) => {
    if (options.args[0] === "diff") return { ok: true, stdout: "diff --git a/file b/file\n+change\n", stderr: "" };
    return OK;
  });

  assert.deepEqual(await captureWorktreePatch({ worktreePath: "/tmp/worktree", baselineOid: BASELINE_OID, runner }), {
    patch: "diff --git a/file b/file\n+change\n",
    changed: true,
  });
  assert.deepEqual(runner.calls.map((call) => call.args), [
    ["add", "-N", "."],
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-color", BASELINE_OID, "--"],
  ]);
  assert.equal(runner.calls[1]?.maxBufferBytes, 16 << 20);
});

test("validateWorktreePatch rejects inconsistent cached patch metadata without invoking git", async () => {
  const runner = fakeRunner(() => OK);

  const missingPatch = await validateWorktreePatch({
    worktreePath: "/tmp/worktree",
    candidate: { patch: "", changed: true },
    runner,
  });
  const unexpectedPatch = await validateWorktreePatch({
    worktreePath: "/tmp/worktree",
    candidate: { patch: "diff --git a/file b/file\n", changed: false },
    runner,
  });

  assert.equal(missingPatch.ok, false);
  assert.match(missingPatch.error ?? "", /changed flag does not match patch content/);
  assert.equal(unexpectedPatch.ok, false);
  assert.match(unexpectedPatch.error ?? "", /changed flag does not match patch content/);
  assert.equal(runner.calls.length, 0);
});

test("WorktreeRegistry validates non-empty cached patches with git apply --check without applying them", async () => {
  const runner = fakeRunner(() => OK);
  const registry = new WorktreeRegistry("/repo", { runner, timeoutMs: 456 });
  const candidate = { patch: "diff --git a/file b/file\n+change\n", changed: true } as const;

  assert.deepEqual(await registry.validatePatch("/tmp/worktree", candidate), OK);
  assert.deepEqual(runner.calls, [
    {
      cwd: "/tmp/worktree",
      args: ["apply", "--check", "--binary", "-"],
      stdin: candidate.patch,
      signal: undefined,
      timeoutMs: 456,
    },
  ]);
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
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  await mkdir(join(repo, "nested", "workflow"), { recursive: true });
  await mkdir(join(repo, "ignored"), { recursive: true });
  await mkdir(join(repo, ".pi", ".workflow-runs"), { recursive: true });
  await mkdir(join(repo, "empty"), { recursive: true });
  await writeFile(join(repo, "nested", "workflow", "entry.txt"), "nested\n");
  await writeFile(join(repo, "ignored", "secret.txt"), "secret\n");
  await writeFile(join(repo, ".pi", ".workflow-runs", "run.jsonl"), "journal\n");
  let added: Awaited<ReturnType<typeof addWorktree>> | undefined;
  let repeated: Awaited<ReturnType<typeof addWorktree>> | undefined;
  try {
    added = await addWorktree({ repoCwd: join(repo, "nested", "workflow") });
    assert.ok(!("error" in added), "addWorktree should succeed via snapshot fallback");
    assert.equal(added.snapshot, true);
    const worktreePath = added.path;
    assert.equal(await readFile(join(worktreePath, "README.md"), "utf8"), "hello\n");
    assert.equal(await readFile(join(worktreePath, "nested", "workflow", "entry.txt"), "utf8"), "nested\n");
    await assert.rejects(() => stat(join(worktreePath, "ignored")));
    await assert.rejects(() => stat(join(worktreePath, ".pi", ".workflow-runs")));
    await assert.rejects(() => stat(join(worktreePath, "empty")));

    repeated = await addWorktree({ repoCwd: join(repo, "nested", "workflow") });
    assert.ok(!("error" in repeated));
    assert.equal(repeated.baselineOid, added.baselineOid);

    await writeFile(join(worktreePath, "route.txt"), "generated\n");
    const patch = await captureWorktreePatch({ worktreePath, baselineOid: added.baselineOid });
    assert.ok(!("error" in patch), "patch capture should work in fallback snapshot");
    assert.equal(patch.changed, true);
    assert.match(patch.patch, /diff --git a\/route\.txt b\/route\.txt/);
    assert.match(patch.patch, /\+generated/);
  } finally {
    if (repeated && !("error" in repeated)) await removeWorktree({ repoCwd: repo, path: repeated.path, snapshot: repeated.snapshot });
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
    const patch = await captureWorktreePatch({ worktreePath: added.path, baselineOid: added.baselineOid });
    assert.ok(!("error" in patch));
    assert.match(patch.patch, /diff --git a\/committed\.txt b\/committed\.txt/);
  } finally {
    if (added && !("error" in added)) await removeWorktree({ repoCwd: repo, path: added.path, snapshot: added.snapshot });
    await rm(repo, { recursive: true, force: true });
  }
});

test("captured patches retain committed isolated edits and reconstruct from the immutable baseline", async () => {
  const repo = await makeTempGitRepo("pi-workflow-committed-agent-edit-");
  const registry = new WorktreeRegistry(repo);
  try {
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    const initialCommit = spawnSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"],
      { cwd: repo, encoding: "utf8" },
    );
    assert.equal(initialCommit.status, 0, initialCommit.stderr);

    const changed = await registry.add();
    assert.ok(!("error" in changed));
    await writeFile(join(changed.path, "app.ts"), "committed by agent\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: changed.path }).status, 0);
    const agentCommit = spawnSync(
      "git",
      ["-c", "user.name=agent", "-c", "user.email=agent@example.invalid", "commit", "-m", "agent edit"],
      { cwd: changed.path, encoding: "utf8" },
    );
    assert.equal(agentCommit.status, 0, agentCommit.stderr);
    const movedHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: changed.path, encoding: "utf8" }).stdout.trim();
    assert.notEqual(movedHead, changed.baselineOid);

    const captured = await registry.capturePatch(changed.path, changed.baselineOid);
    assert.ok(!("error" in captured));
    assert.equal(captured.changed, true);
    assert.match(captured.patch, /-before/);
    assert.match(captured.patch, /\+committed by agent/);

    const reconstruction = await registry.add();
    assert.ok(!("error" in reconstruction));
    const applied = spawnSync("git", ["apply", "--index", "--binary", "-"], {
      cwd: reconstruction.path,
      input: captured.patch,
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(await readFile(join(reconstruction.path, "app.ts"), "utf8"), "committed by agent\n");
  } finally {
    await registry.removeAll();
    await rm(repo, { recursive: true, force: true });
  }
});

test("captured patches reconstruct binary, new, symlink, mode, and deletion changes", async () => {
  const repo = await makeTempGitRepo("pi-workflow-patch-integrity-");
  const registry = new WorktreeRegistry(repo);
  const originalBinary = Buffer.from([0, 1, 2, 3, 4, 5]);
  const changedBinary = Buffer.from([0, 8, 7, 6, 5, 4, 3, 2, 1]);
  try {
    await writeFile(join(repo, "binary.dat"), originalBinary);
    await writeFile(join(repo, "delete.txt"), "delete me\n");
    await writeFile(join(repo, "mode.sh"), "#!/bin/sh\nexit 0\n");
    await writeFile(join(repo, "target-old.txt"), "old target\n");
    await writeFile(join(repo, "target-new.txt"), "new target\n");
    await symlink("target-old.txt", join(repo, "linked.txt"));
    assert.equal(spawnSync("git", ["add", "-A"], { cwd: repo }).status, 0);
    const commit = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(commit.status, 0, commit.stderr);

    const changed = await registry.add();
    assert.ok(!("error" in changed));
    await writeFile(join(changed.path, "binary.dat"), changedBinary);
    await writeFile(join(changed.path, "new.txt"), "new file\n");
    await rm(join(changed.path, "delete.txt"));
    await chmod(join(changed.path, "mode.sh"), 0o755);
    await rm(join(changed.path, "linked.txt"));
    await symlink("target-new.txt", join(changed.path, "linked.txt"));

    const captured = await registry.capturePatch(changed.path, changed.baselineOid);
    assert.ok(!("error" in captured));
    assert.equal(captured.changed, true);
    assert.match(captured.patch, /GIT binary patch/);
    assert.match(captured.patch, /new file mode 100644/);
    assert.match(captured.patch, /deleted file mode 100644/);
    assert.match(captured.patch, /old mode 100644\nnew mode 100755/);
    assert.match(captured.patch, /index [0-9a-f]{40,64}\.\.[0-9a-f]{40,64} 120000/);

    const baseline = await registry.add();
    assert.ok(!("error" in baseline));
    const invalid = await registry.validatePatch(baseline.path, {
      changed: true,
      patch: "diff --git a/delete.txt b/delete.txt\n--- a/delete.txt\n+++ b/delete.txt\n@@ -1 +1 @@\n-not the baseline\n+invalid\n",
    });
    assert.equal(invalid.ok, false);
    assert.equal(await readFile(join(baseline.path, "delete.txt"), "utf8"), "delete me\n");

    const valid = await registry.validatePatch(baseline.path, captured);
    assert.equal(valid.ok, true, valid.error ?? valid.stderr);
    assert.deepEqual(await readFile(join(baseline.path, "binary.dat")), originalBinary);
    await assert.rejects(readFile(join(baseline.path, "new.txt")));
    assert.equal(await readlink(join(baseline.path, "linked.txt")), "target-old.txt");

    const applied = spawnSync("git", ["apply", "--index", "--binary", "-"], {
      cwd: baseline.path,
      input: captured.patch,
      encoding: "utf8",
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.deepEqual(await readFile(join(baseline.path, "binary.dat")), changedBinary);
    assert.equal(await readFile(join(baseline.path, "new.txt"), "utf8"), "new file\n");
    await assert.rejects(readFile(join(baseline.path, "delete.txt")));
    assert.notEqual((await stat(join(baseline.path, "mode.sh"))).mode & 0o111, 0);
    assert.equal(await readlink(join(baseline.path, "linked.txt")), "target-new.txt");
  } finally {
    await registry.removeAll();
    await rm(repo, { recursive: true, force: true });
  }
});

test("a reviewed-snapshot baseline is excluded from the returned fix patch", async () => {
  const repo = await makeTempGitRepo("pi-workflow-reviewed-baseline-");
  let added: Awaited<ReturnType<typeof addWorktree>> | undefined;
  let repeated: Awaited<ReturnType<typeof addWorktree>> | undefined;
  try {
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    const reviewedPatch = "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-before\n+reviewed\n";

    added = await addWorktree({ repoCwd: repo, baseline: { ref: head, patch: reviewedPatch } });
    assert.ok(!("error" in added));
    assert.equal(await readFile(join(added.path, "app.ts"), "utf8"), "reviewed\n");

    repeated = await addWorktree({ repoCwd: repo, baseline: { ref: head, patch: reviewedPatch } });
    assert.ok(!("error" in repeated));
    assert.equal(repeated.baselineOid, added.baselineOid);

    await writeFile(join(added.path, "app.ts"), "fixed\n");
    const captured = await captureWorktreePatch({ worktreePath: added.path, baselineOid: added.baselineOid });
    assert.ok(!("error" in captured));
    assert.match(captured.patch, /-reviewed/);
    assert.match(captured.patch, /\+fixed/);
    assert.doesNotMatch(captured.patch, /-before/);
  } finally {
    if (repeated && !("error" in repeated)) await removeWorktree({ repoCwd: repo, path: repeated.path, snapshot: repeated.snapshot });
    if (added && !("error" in added)) await removeWorktree({ repoCwd: repo, path: added.path, snapshot: added.snapshot });
    await rm(repo, { recursive: true, force: true });
  }
});

test("reviewed-snapshot preparation bypasses repository commit hooks and signing", async () => {
  const repo = await makeTempGitRepo("pi-workflow-reviewed-policy-");
  let added: Awaited<ReturnType<typeof addWorktree>> | undefined;
  try {
    await writeFile(join(repo, "app.ts"), "before\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);
    assert.equal(
      spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"], { cwd: repo }).status,
      0,
    );
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim();
    await writeFile(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    await chmod(join(repo, ".git", "hooks", "pre-commit"), 0o755);
    assert.equal(spawnSync("git", ["config", "commit.gpgSign", "true"], { cwd: repo }).status, 0);

    added = await addWorktree({
      repoCwd: repo,
      baseline: {
        ref: head,
        patch:
          "diff --git a/app.ts b/app.ts\n--- a/app.ts\n+++ b/app.ts\n@@ -1 +1 @@\n-before\n+reviewed\n" +
          "diff --git a/.pi-workflow-hooks-disabled/prepare-commit-msg b/.pi-workflow-hooks-disabled/prepare-commit-msg\n" +
          "new file mode 100755\n--- /dev/null\n+++ b/.pi-workflow-hooks-disabled/prepare-commit-msg\n@@ -0,0 +1,2 @@\n+#!/bin/sh\n+exit 1\n",
      },
    });

    assert.ok(!("error" in added), "baseline commit should bypass hooks and signing");
    assert.equal(await readFile(join(added.path, "app.ts"), "utf8"), "reviewed\n");
    assert.equal(await readFile(join(added.path, ".pi-workflow-hooks-disabled", "prepare-commit-msg"), "utf8"), "#!/bin/sh\nexit 1\n");
  } finally {
    if (added && !("error" in added)) await removeWorktree({ repoCwd: repo, path: added.path, snapshot: added.snapshot });
    await rm(repo, { recursive: true, force: true });
  }
});
