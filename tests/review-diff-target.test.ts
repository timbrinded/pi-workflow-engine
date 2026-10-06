import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import { parseAllowedDiffCommand, reviewDiffCommand } from "../.pi/extensions/pi-workflow-engine/src/review-diff-target.ts";

test("parseAllowedDiffCommand accepts safe git and gh diff commands", () => {
  assert.deepEqual(parseAllowedDiffCommand("git diff main...HEAD -- src/app.ts"), {
    kind: "git",
    args: ["diff", "--no-ext-diff", "main...HEAD", "--", "src/app.ts"],
  });
  assert.deepEqual(parseAllowedDiffCommand("gh pr diff 123"), {
    kind: "pull-request",
    number: 123,
  });
  const patchSeries = parseAllowedDiffCommand("gh pr diff 123 --patch");
  if (!("error" in patchSeries)) assert.fail("expected --patch to be rejected");
  assert.match(patchSeries.error, /cumulative/);
  assert.deepEqual(parseAllowedDiffCommand("git diff --binary HEAD"), {
    kind: "git",
    args: ["diff", "--no-ext-diff", "--binary", "HEAD"],
  });
  const otherExecutable = parseAllowedDiffCommand("cat package.json");
  if (!("error" in otherExecutable)) assert.fail("expected non-diff executables to be rejected");
  assert.match(otherExecutable.error, /allowlist/);
  assert.ok("error" in parseAllowedDiffCommand("git status"));
  assert.ok("error" in parseAllowedDiffCommand("git diff main; rm -rf /"));
});

test("parseAllowedDiffCommand requires explicit path and revision boundaries", () => {
  assert.deepEqual(parseAllowedDiffCommand("git diff -- README.md USAGE.md"), {
    kind: "git",
    args: ["diff", "--no-ext-diff", "--", "README.md", "USAGE.md"],
  });
  assert.ok("error" in parseAllowedDiffCommand("git diff README.md USAGE.md"));
  assert.ok("error" in parseAllowedDiffCommand("git diff HEAD:README.md HEAD:USAGE.md"));
  assert.deepEqual(parseAllowedDiffCommand("git diff --cached -- app.ts"), {
    kind: "git",
    args: ["diff", "--no-ext-diff", "--cached", "--", "app.ts"],
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

test("pull-request capture always uses the cumulative diff argv", () => {
  const target = parseAllowedDiffCommand("gh pr diff 123 --color=never");
  if ("error" in target) assert.fail(target.error);
  assert.deepEqual(reviewDiffCommand(target), {
    file: "gh",
    args: ["pr", "diff", "123", "--color=never"],
  });
  assert.equal(reviewDiffCommand(target).args.includes("--patch"), false);
});

test("review diff targets stay a pure schema module that cannot spawn processes", async () => {
  const source = await readFile(".pi/extensions/pi-workflow-engine/src/review-diff-target.ts", "utf8");
  assert.doesNotMatch(source, /process-runner|node:child_process|\.\/git\.ts/);
});
