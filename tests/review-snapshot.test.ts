import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ReviewContext } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import {
  captureReviewMaterial,
  resolveReviewWorktreeBaseline,
  type VerifiedReviewSnapshot,
} from "../.pi/extensions/pi-workflow-engine/src/review/review-snapshot.ts";

function verifiedSnapshot(material: Awaited<ReturnType<typeof captureReviewMaterial>>): VerifiedReviewSnapshot {
  if (!material.ok) assert.fail(material.error);
  if (material.snapshot.status !== "verified") assert.fail(material.snapshot.reason);
  return material.snapshot;
}

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
    const snapshot = verifiedSnapshot(material);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "dirty worktree",
      diffCommand: "git diff",
      files: ["app.ts"],
      snapshot: snapshot.identity,
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
      snapshot: {
        diffFingerprint: createHash("sha256").update("different diff").digest("hex"),
        baselineFingerprint: createHash("sha256").update("different baseline").digest("hex"),
      },
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
    const snapshot = verifiedSnapshot(material);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "HEAD~1...HEAD",
      diffCommand: "git diff HEAD~1...HEAD",
      files: ["app.ts"],
      snapshot: snapshot.identity,
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
    const snapshot = verifiedSnapshot(material);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "app.ts",
      diffCommand: "git diff -- app.ts",
      files: ["app.ts"],
      snapshot: snapshot.identity,
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
    const snapshot = verifiedSnapshot(material);
    const context: ReviewContext = {
      workflowName: "code-review",
      target: "index",
      diffCommand: "git diff --cached",
      files: ["app.ts"],
      snapshot: snapshot.identity,
    };
    await writeFile(join(repo, "app.ts"), "later unstaged content\n");

    const baseline = await resolveReviewWorktreeBaseline(context, repo);

    assert.match(baseline.patch ?? "", /\+reviewed index/);
    assert.doesNotMatch(baseline.patch ?? "", /later unstaged content/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review baseline requires explicit file operands and rejects ambiguous blob pairs", async () => {
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

    const paths = await captureReviewMaterial("git diff -- README.md USAGE.md", repo);
    const singlePath = await captureReviewMaterial("git diff -- README.md", repo);
    const blobPair = await captureReviewMaterial("git diff HEAD:README.md HEAD:USAGE.md", repo);
    const pathsSnapshot = verifiedSnapshot(paths);
    const singlePathSnapshot = verifiedSnapshot(singlePath);

    assert.equal(pathsSnapshot.baseline.ref, head);
    assert.match(pathsSnapshot.baseline.patch ?? "", /reviewed readme/);
    assert.match(pathsSnapshot.baseline.patch ?? "", /reviewed usage/);
    assert.equal(singlePathSnapshot.baseline.ref, head);
    if (!singlePath.ok) assert.fail(singlePath.error);
    assert.match(singlePath.diff, /reviewed readme/);
    assert.doesNotMatch(singlePath.diff, /reviewed usage/);
    assert.equal(blobPair.ok, false);
    if (blobPair.ok) assert.fail("expected ambiguous blob pair to be rejected");
    assert.match(blobPair.error, /ambiguous git diff operands/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("review material preserves its captured diff when baseline verification is unavailable", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-review-unborn-"));
  try {
    assert.equal(spawnSync("git", ["init"], { cwd: repo }).status, 0);
    await writeFile(join(repo, "app.ts"), "reviewed index\n");
    assert.equal(spawnSync("git", ["add", "app.ts"], { cwd: repo }).status, 0);

    const material = await captureReviewMaterial("git diff --cached", repo);

    if (!material.ok) assert.fail(material.error);
    assert.match(material.diff, /\+reviewed index/);
    assert.equal(material.snapshot.status, "unavailable");
    if (material.snapshot.status !== "unavailable") assert.fail("expected unavailable snapshot");
    assert.match(material.snapshot.reason, /no committed HEAD baseline/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
