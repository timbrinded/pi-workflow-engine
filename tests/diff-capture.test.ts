import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { captureDiff, parseAllowedDiffCommand } from "../.pi/extensions/pi-workflow-engine/src/diff-capture.ts";

async function fakeBin(script: string): Promise<{ dir: string; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "workflow-engine-diff-bin-"));
  await mkdir(dir, { recursive: true });
  const file = join(dir, "git");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return {
    dir,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

test("parseAllowedDiffCommand accepts safe git and gh diff commands", () => {
  assert.deepEqual(parseAllowedDiffCommand("git diff main...HEAD -- src/app.ts"), {
    kind: "git",
    file: "git",
    args: ["diff", "--no-ext-diff", "main...HEAD", "--", "src/app.ts"],
    baseline: { kind: "range", ref: "HEAD" },
  });
  assert.deepEqual(parseAllowedDiffCommand("gh pr diff 123 --patch"), {
    kind: "pull-request",
    file: "gh",
    args: ["pr", "diff", "123", "--patch", "--color=never"],
    pullRequestNumber: "123",
  });
  assert.deepEqual(parseAllowedDiffCommand("git diff --binary HEAD"), {
    kind: "git",
    file: "git",
    args: ["diff", "--no-ext-diff", "--binary", "HEAD"],
    baseline: { kind: "working-tree" },
  });
  assert.ok("error" in parseAllowedDiffCommand("git status"));
  assert.ok("error" in parseAllowedDiffCommand("git diff main; rm -rf /"));
});

test("parseAllowedDiffCommand requires explicit path and revision boundaries", () => {
  assert.deepEqual(parseAllowedDiffCommand("git diff -- README.md USAGE.md"), {
    kind: "git",
    file: "git",
    args: ["diff", "--no-ext-diff", "--", "README.md", "USAGE.md"],
    baseline: { kind: "working-tree" },
  });
  assert.ok("error" in parseAllowedDiffCommand("git diff README.md USAGE.md"));
  assert.ok("error" in parseAllowedDiffCommand("git diff HEAD:README.md HEAD:USAGE.md"));
  assert.deepEqual(parseAllowedDiffCommand("git diff --cached -- app.ts"), {
    kind: "git",
    file: "git",
    args: ["diff", "--no-ext-diff", "--cached", "--", "app.ts"],
    baseline: { kind: "index" },
  });
});

test("parseAllowedDiffCommand rejects side-effecting git diff options", () => {
  const outputEquals = parseAllowedDiffCommand("git diff --output=.tmp-diff HEAD");
  if (!("error" in outputEquals)) assert.fail("expected --output= to be rejected");
  assert.match(outputEquals.error, /unsupported/);
  assert.ok("error" in parseAllowedDiffCommand("git diff --output .tmp-diff HEAD"));
  assert.ok("error" in parseAllowedDiffCommand("git diff --ext-diff HEAD"));
  assert.ok("error" in parseAllowedDiffCommand("git diff --no-index a b"));
  assert.ok("error" in parseAllowedDiffCommand("gh pr diff 123 --repo=other/repo"));
  assert.ok("error" in parseAllowedDiffCommand("gh pr diff 123 --web"));
  assert.ok("error" in parseAllowedDiffCommand("gh pr diff 123 --name-only"));
});

test("captureDiff captures stdout for an allowed command", async () => {
  const bin = await fakeBin("#!/usr/bin/env bash\nprintf 'diff --git a/a b/a\\n+hello\\n'\n");
  try {
    const result = await captureDiff("git diff HEAD", { cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 1_000, env: bin.env });
    assert.equal(result.ok, true);
    assert.match(result.stdout, /\+hello/);
    assert.ok(result.bytes > 0);
  } finally {
    await bin.cleanup();
  }
});

test("captureDiff rejects unsupported commands without spawning", async () => {
  const result = await captureDiff("cat package.json", { cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 1_000 });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /allowlist/);
});

test("captureDiff enforces max buffer", async () => {
  const bin = await fakeBin("#!/usr/bin/env bash\npython3 - <<'PY'\nprint('x' * 2000)\nPY\n");
  try {
    const result = await captureDiff("git diff HEAD", { cwd: process.cwd(), timeoutMs: 1_000, maxBufferBytes: 100, env: bin.env });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /exceeded/);
  } finally {
    await bin.cleanup();
  }
});

test("captureDiff enforces timeout", async () => {
  const bin = await fakeBin("#!/usr/bin/env bash\nwhile true; do :; done\n");
  try {
    const result = await captureDiff("git diff HEAD", { cwd: process.cwd(), timeoutMs: 10, maxBufferBytes: 1_000, env: bin.env, killGraceMs: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/);
  } finally {
    await bin.cleanup();
  }
});

test("captureDiff honors abort signals", async () => {
  const bin = await fakeBin("#!/usr/bin/env bash\nwhile true; do :; done\n");
  const controller = new AbortController();
  try {
    const running = captureDiff("git diff HEAD", { cwd: process.cwd(), signal: controller.signal, timeoutMs: 1_000, maxBufferBytes: 1_000, env: bin.env, killGraceMs: 5 });
    controller.abort();
    const result = await running;
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /aborted/);
  } finally {
    await bin.cleanup();
  }
});

test("captureDiff resolves when child ignores SIGTERM", async () => {
  const bin = await fakeBin("#!/usr/bin/env bash\ntrap '' TERM\nwhile true; do :; done\n");
  try {
    const result = await captureDiff("git diff HEAD", { cwd: process.cwd(), timeoutMs: 10, maxBufferBytes: 1_000, env: bin.env, killGraceMs: 5 });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /timed out/);
  } finally {
    await bin.cleanup();
  }
});
