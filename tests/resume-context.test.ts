import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  captureRepositoryResumeContext,
  captureWorkflowResumeContext,
  createWorkflowSourceFingerprintCache,
} from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { createGitRepo } from "./resume-fixtures.ts";

test("repository capture is stable for genuine non-git directories but not failed probes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-non-git-context-"));
  const missing = join(cwd, "missing");
  try {
    await writeFile(join(cwd, "input.txt"), "first\n", "utf8");
    const first = await captureRepositoryResumeContext(cwd);
    const second = await captureRepositoryResumeContext(cwd);
    assert.equal(first.kind, "verified");
    assert.deepEqual(second, first);

    await writeFile(join(cwd, "input.txt"), "second\n", "utf8");
    const changed = await captureRepositoryResumeContext(cwd);
    assert.equal(changed.kind, "verified");
    if (changed.kind !== "verified" || first.kind !== "verified") assert.fail("expected verified repository contexts");
    assert.notEqual(changed.workingTreeFingerprint, first.workingTreeFingerprint);

    const failed = await captureRepositoryResumeContext(missing);
    assert.equal(failed.kind, "unverifiable");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture bounds untracked file content", async () => {
  const cwd = await createGitRepo();
  const path = join(cwd, "oversized-untracked.bin");
  try {
    await writeFile(path, "", "utf8");
    await truncate(path, (32 << 20) + 1);
    const context = await captureRepositoryResumeContext(cwd);
    assert.equal(context.kind, "unverifiable");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("file workflow provenance uses its explicit root and memoizes that root per run", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-source-context-"));
  const sourcePath = join(root, "workflow.ts");
  const helperPath = join(root, "helper.ts");
  const workflow: LoadedWorkflow = {
    meta: { name: "source-context", description: "" },
    default: async () => "ok",
    source: { kind: "file", path: sourcePath, root },
  };
  try {
    await writeFile(sourcePath, 'import "./helper.ts";\n', "utf8");
    await writeFile(helperPath, "export const value = 'one';\n", "utf8");
    const cache = createWorkflowSourceFingerprintCache();
    const first = await captureWorkflowResumeContext(workflow, cache);
    assert.equal(first.kind, "verified");

    await writeFile(helperPath, "export const value = 'two';\n", "utf8");
    const memoized = await captureWorkflowResumeContext(workflow, cache);
    assert.deepEqual(memoized, first);

    const refreshed = await captureWorkflowResumeContext(workflow, createWorkflowSourceFingerprintCache());
    assert.equal(refreshed.kind, "verified");
    if (first.kind !== "verified" || refreshed.kind !== "verified") assert.fail("expected verified workflow contexts");
    assert.notEqual(refreshed.sourceFingerprint, first.sourceFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file workflow provenance rejects a source outside its declared root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-source-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-workflow-source-outside-"));
  const sourcePath = join(outside, "workflow.ts");
  try {
    await writeFile(sourcePath, "export default async () => 'ok';\n", "utf8");
    const context = await captureWorkflowResumeContext(
      {
        meta: { name: "outside-root", description: "" },
        default: async () => "ok",
        source: { kind: "file", path: sourcePath, root },
      },
      createWorkflowSourceFingerprintCache(),
    );
    assert.deepEqual(context, {
      kind: "unverifiable",
      name: "outside-root",
      reason: "workflow source file is outside its declared source root",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("file workflow provenance rejects source paths hidden behind a directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-source-symlink-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-workflow-source-symlink-target-"));
  const sourcePath = join(outside, "workflow.ts");
  try {
    await writeFile(sourcePath, "export default async () => 'ok';\n", "utf8");
    await symlink(outside, join(root, "linked"), "dir");
    const context = await captureWorkflowResumeContext(
      {
        meta: { name: "symlink-source", description: "" },
        default: async () => "ok",
        source: { kind: "file", path: join(root, "linked", "workflow.ts"), root },
      },
      createWorkflowSourceFingerprintCache(),
    );
    assert.equal(context.kind, "unverifiable");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
