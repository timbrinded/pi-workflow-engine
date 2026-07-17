import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  captureRepositoryMutationGuard,
  captureIsolatedRepositoryContext,
  captureRepositoryResumeContext,
  captureWorkflowResumeContext,
  createAgentResumeContext,
  resumeContextMismatchReason,
} from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import type { LoadedWorkflow } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import {
  captureDeclaredInputFingerprint,
  captureTreeFingerprint,
  isPathWithin,
  validateTreeFile,
} from "../.pi/extensions/pi-workflow-engine/src/tree-fingerprint.ts";
import { createGitRepo, runGit } from "./resume-fixtures.ts";

test("repository capture is stable for genuine non-git directories but not failed probes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-non-git-context-"));
  const missing = join(cwd, "missing");
  try {
    await writeFile(join(cwd, "input.txt"), "first\n", "utf8");
    const first = await captureRepositoryResumeContext(cwd, ["input.txt"]);
    const second = await captureRepositoryResumeContext(cwd, ["input.txt"]);
    assert.equal(first.kind, "verified");
    assert.deepEqual(second, first);

    await writeFile(join(cwd, "input.txt"), "second\n", "utf8");
    const changed = await captureRepositoryResumeContext(cwd, ["input.txt"]);
    assert.equal(changed.kind, "verified");
    if (changed.kind !== "verified" || first.kind !== "verified") assert.fail("expected verified repository contexts");
    assert.notEqual(changed.workingTreeFingerprint, first.workingTreeFingerprint);

    const failed = await captureRepositoryResumeContext(missing, []);
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
    const context = await captureRepositoryResumeContext(cwd, ["oversized-untracked.bin"]);
    assert.equal(context.kind, "unverifiable");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture fingerprints declared ignored files and untracked file modes", async () => {
  const cwd = await createGitRepo();
  const ignoredPath = join(cwd, "secret.local");
  const modePath = join(cwd, "script.sh");
  try {
    await writeFile(join(cwd, ".gitignore"), ".pi/.workflow-runs/\nsecret.local\n", "utf8");
    await writeFile(ignoredPath, "one\n", "utf8");
    await writeFile(modePath, "#!/bin/sh\n", "utf8");
    await chmod(modePath, 0o644);
    const inputs = ["secret.local", "script.sh"];
    const first = await captureRepositoryResumeContext(cwd, inputs);
    const gitVisibleOnly = await captureRepositoryResumeContext(cwd, []);
    assert.equal(first.kind, "verified");
    assert.equal(gitVisibleOnly.kind, "verified");

    await writeFile(ignoredPath, "two\n", "utf8");
    assert.deepEqual(await captureRepositoryResumeContext(cwd, []), gitVisibleOnly);
    const ignoredChanged = await captureRepositoryResumeContext(cwd, inputs);
    assert.equal(ignoredChanged.kind, "verified");
    if (first.kind !== "verified" || ignoredChanged.kind !== "verified") assert.fail("expected verified contexts");
    assert.notEqual(ignoredChanged.workingTreeFingerprint, first.workingTreeFingerprint);

    await chmod(modePath, 0o755);
    const modeChanged = await captureRepositoryResumeContext(cwd, inputs);
    assert.equal(modeChanged.kind, "verified");
    if (modeChanged.kind !== "verified") assert.fail("expected verified context");
    assert.notEqual(modeChanged.workingTreeFingerprint, ignoredChanged.workingTreeFingerprint);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture ignores generated trees but binds the full Git-visible workspace", async () => {
  const cwd = await createGitRepo();
  const declared = join(cwd, "config", "review-input.txt");
  const dependency = join(cwd, "node_modules", "local-package", "index.js");
  const artifact = join(cwd, ".artifacts", "pi-e2e", "fix-repo", ".git", "config");
  try {
    await writeFile(join(cwd, ".gitignore"), ".pi/.workflow-runs/\nnode_modules/\n.artifacts/\n", "utf8");
    runGit(cwd, ["add", ".gitignore"]);
    runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "ignore generated trees"]);
    await mkdir(join(cwd, "config"), { recursive: true });
    await mkdir(join(cwd, "node_modules", "local-package"), { recursive: true });
    await mkdir(join(cwd, ".artifacts", "pi-e2e", "fix-repo", ".git"), { recursive: true });
    await writeFile(declared, "one\n", "utf8");
    await writeFile(dependency, "export const value = 1;\n", "utf8");
    await writeFile(artifact, "artifact one\n", "utf8");
    const first = await captureRepositoryResumeContext(cwd, []);
    assert.equal(first.kind, "verified");

    await writeFile(dependency, "export const value = 2;\n", "utf8");
    await writeFile(artifact, "artifact two\n", "utf8");
    assert.deepEqual(await captureRepositoryResumeContext(cwd, []), first);

    await writeFile(join(cwd, "tracked.txt"), "unrelated tracked edit\n", "utf8");
    const trackedChanged = await captureRepositoryResumeContext(cwd, []);
    assert.equal(trackedChanged.kind, "verified");
    if (first.kind !== "verified" || trackedChanged.kind !== "verified") assert.fail("expected verified repository contexts");
    assert.notEqual(trackedChanged.workingTreeFingerprint, first.workingTreeFingerprint);

    await writeFile(declared, "two\n", "utf8");
    const changed = await captureRepositoryResumeContext(cwd, []);
    assert.equal(changed.kind, "verified");
    if (changed.kind !== "verified") assert.fail("expected verified repository context");
    assert.notEqual(changed.workingTreeFingerprint, trackedChanged.workingTreeFingerprint);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture excludes root and nested workflow journals from a subdirectory", async () => {
  const root = await createGitRepo({ ignoreJournal: false });
  const cwd = join(root, "nested");
  const rootJournal = join(root, ".pi", ".workflow-runs", "root.jsonl");
  const nestedJournal = join(cwd, ".pi", ".workflow-runs", "nested.jsonl");
  try {
    await mkdir(join(cwd, ".pi", ".workflow-runs"), { recursive: true });
    await mkdir(join(root, ".pi", ".workflow-runs"), { recursive: true });
    await writeFile(rootJournal, "one\n", "utf8");
    await writeFile(nestedJournal, "one\n", "utf8");
    const first = await captureRepositoryResumeContext(cwd, ["."]);
    assert.equal(first.kind, "verified");

    await writeFile(rootJournal, "two\n", "utf8");
    await writeFile(nestedJournal, "two\n", "utf8");
    assert.deepEqual(await captureRepositoryResumeContext(cwd, ["."]), first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repository capture and mutation guards use the Git root from nested working directories", async () => {
  const root = await createGitRepo();
  const cwd = join(root, "nested", "workflow");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, "entry.txt"), "nested\n", "utf8");
    runGit(root, ["add", "nested/workflow/entry.txt"]);
    runGit(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "nested cwd"]);

    const rootContext = await captureRepositoryResumeContext(root, []);
    const nestedContext = await captureRepositoryResumeContext(cwd, []);
    assert.deepEqual(nestedContext, rootContext);
    const firstGuard = await captureRepositoryMutationGuard(cwd);
    assert.equal(firstGuard.kind, "verified");

    await writeFile(join(root, "tracked.txt"), "changed above cwd\n", "utf8");
    const dirty = await captureRepositoryResumeContext(cwd, []);
    assert.equal(dirty.kind, "verified");
    if (nestedContext.kind !== "verified" || dirty.kind !== "verified") assert.fail("expected verified contexts");
    assert.notEqual(dirty.workingTreeFingerprint, nestedContext.workingTreeFingerprint);

    runGit(root, ["add", "tracked.txt"]);
    runGit(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "parent change"]);
    const committedGuard = await captureRepositoryMutationGuard(cwd);
    assert.equal(committedGuard.kind, "verified");
    if (firstGuard.kind !== "verified" || committedGuard.kind !== "verified") assert.fail("expected verified guards");
    assert.notEqual(committedGuard.fingerprint, firstGuard.fingerprint);

    await writeFile(join(root, "untracked-above.txt"), "untracked\n", "utf8");
    const untracked = await captureRepositoryResumeContext(cwd, []);
    assert.equal(untracked.kind, "verified");
    if (untracked.kind !== "verified") assert.fail("expected verified context");
    assert.notEqual(untracked.workingTreeFingerprint, dirty.workingTreeFingerprint);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested declared inputs capture ignored cwd contents and cannot escape that cwd", async () => {
  const root = await createGitRepo();
  const cwd = join(root, "nested", "workflow");
  try {
    await mkdir(cwd, { recursive: true });
    await writeFile(join(root, ".gitignore"), "nested/workflow/generated/\n", "utf8");
    runGit(root, ["add", ".gitignore"]);
    runGit(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "ignore generated input"]);
    await mkdir(join(cwd, "generated"));
    await writeFile(join(cwd, "generated", "value.txt"), "one\n", "utf8");

    const first = await captureRepositoryResumeContext(cwd, ["."]);
    assert.equal(first.kind, "verified");
    await writeFile(join(cwd, "generated", "value.txt"), "two\n", "utf8");
    const changed = await captureRepositoryResumeContext(cwd, ["."]);
    assert.equal(changed.kind, "verified");
    if (first.kind !== "verified" || changed.kind !== "verified") assert.fail("expected verified contexts");
    assert.notEqual(changed.workingTreeFingerprint, first.workingTreeFingerprint);

    const escaped = await captureRepositoryResumeContext(cwd, ["../outside.txt"]);
    assert.equal(escaped.kind, "unverifiable");
    if (escaped.kind !== "unverifiable") assert.fail("expected workflow cwd escape rejection");
    assert.match(escaped.reason, /escapes the workflow cwd/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated mutation guard ignores generated trees but detects worktree and index changes", async () => {
  const cwd = await createGitRepo({ ignoreJournal: false });
  const ignored = join(cwd, "node_modules", "dependency", "index.js");
  const journal = join(cwd, ".pi", ".workflow-runs", "run.jsonl");
  const tracked = join(cwd, "tracked.txt");
  try {
    await writeFile(join(cwd, ".gitignore"), "node_modules/\n", "utf8");
    runGit(cwd, ["add", ".gitignore"]);
    runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "ignore dependencies"]);
    await mkdir(join(cwd, "node_modules", "dependency"), { recursive: true });
    await mkdir(join(cwd, ".pi", ".workflow-runs"), { recursive: true });
    await writeFile(ignored, "one\n", "utf8");
    await writeFile(journal, "one\n", "utf8");
    await writeFile(tracked, "dirty one\n", "utf8");

    const first = await captureRepositoryMutationGuard(cwd);
    assert.equal(first.kind, "verified");
    await writeFile(ignored, "two\n", "utf8");
    await writeFile(journal, "two\n", "utf8");
    assert.deepEqual(await captureRepositoryMutationGuard(cwd), first);

    await writeFile(tracked, "dirty two\n", "utf8");
    const contentChanged = await captureRepositoryMutationGuard(cwd);
    assert.equal(contentChanged.kind, "verified");
    if (first.kind !== "verified" || contentChanged.kind !== "verified") assert.fail("expected verified guards");
    assert.notEqual(contentChanged.fingerprint, first.fingerprint);

    runGit(cwd, ["update-index", "--chmod=+x", "tracked.txt"]);
    const indexChanged = await captureRepositoryMutationGuard(cwd);
    assert.equal(indexChanged.kind, "verified");
    if (indexChanged.kind !== "verified") assert.fail("expected verified guard");
    assert.notEqual(indexChanged.fingerprint, contentChanged.fingerprint);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("isolated mutation guard does not reread large clean tracked files", async () => {
  const cwd = await createGitRepo();
  const path = join(cwd, "large-clean.bin");
  try {
    await writeFile(path, "", "utf8");
    await truncate(path, (32 << 20) + 1);
    runGit(cwd, ["add", "large-clean.bin"]);
    runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "large clean file"]);
    assert.equal((await captureRepositoryMutationGuard(cwd)).kind, "verified");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture fails closed for tracked and untracked symbolic links", async () => {
  const trackedRepo = await createGitRepo();
  const untrackedRepo = await createGitRepo();
  const targetDir = await mkdtemp(join(tmpdir(), "pi-workflow-symlink-target-"));
  const target = join(targetDir, "outside.txt");
  try {
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, join(trackedRepo, "linked.txt"));
    runGit(trackedRepo, ["add", "linked.txt"]);
    const tracked = await captureRepositoryResumeContext(trackedRepo, ["linked.txt"]);
    assert.equal(tracked.kind, "unverifiable");
    if (tracked.kind !== "unverifiable") assert.fail("expected tracked symlink to be rejected");
    assert.match(tracked.reason, /symbolic link/);

    await symlink(target, join(untrackedRepo, "linked.txt"));
    const untracked = await captureRepositoryResumeContext(untrackedRepo, ["linked.txt"]);
    assert.equal(untracked.kind, "unverifiable");
    if (untracked.kind !== "unverifiable") assert.fail("expected untracked symlink to be rejected");
    assert.match(untracked.reason, /symbolic link/);
  } finally {
    await rm(trackedRepo, { recursive: true, force: true });
    await rm(untrackedRepo, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("repository capture rejects clean tracked and unstaged replacement symbolic links", async () => {
  const cleanRepo = await createGitRepo();
  const replacedRepo = await createGitRepo();
  const gitlinkRepo = await createGitRepo();
  const targetDir = await mkdtemp(join(tmpdir(), "pi-workflow-external-target-"));
  const target = join(targetDir, "outside.txt");
  try {
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, join(cleanRepo, "clean-link.txt"));
    runGit(cleanRepo, ["add", "clean-link.txt"]);
    runGit(cleanRepo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "tracked link"]);
    const clean = await captureRepositoryResumeContext(cleanRepo, []);
    assert.equal(clean.kind, "unverifiable");
    if (clean.kind !== "unverifiable") assert.fail("expected clean tracked symlink rejection");
    assert.match(clean.reason, /tracked symbolic links/);
    const cleanHead = runGit(cleanRepo, ["rev-parse", "HEAD"]);
    const isolated = await captureIsolatedRepositoryContext(cleanRepo, cleanHead);
    assert.equal(isolated.kind, "unverifiable");
    if (isolated.kind !== "unverifiable") assert.fail("expected isolated tracked symlink rejection");
    assert.match(isolated.reason, /tracked symbolic links/);

    const replaced = join(replacedRepo, "tracked.txt");
    await rm(replaced);
    await symlink(target, replaced);
    const unstaged = await captureRepositoryResumeContext(replacedRepo, []);
    assert.equal(unstaged.kind, "unverifiable");
    if (unstaged.kind !== "unverifiable") assert.fail("expected unstaged symlink replacement rejection");
    assert.match(unstaged.reason, /tracked symbolic links/);

    const gitlinkTarget = runGit(gitlinkRepo, ["rev-parse", "HEAD"]);
    runGit(gitlinkRepo, ["update-index", "--add", "--cacheinfo", `160000,${gitlinkTarget},vendor/dependency`]);
    const gitlink = await captureRepositoryResumeContext(gitlinkRepo, []);
    assert.equal(gitlink.kind, "unverifiable");
    if (gitlink.kind !== "unverifiable") assert.fail("expected tracked submodule rejection");
    assert.match(gitlink.reason, /tracked submodules/);
  } finally {
    await rm(cleanRepo, { recursive: true, force: true });
    await rm(replacedRepo, { recursive: true, force: true });
    await rm(gitlinkRepo, { recursive: true, force: true });
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("repository capture gives missing inputs stable identity and rejects unsafe declared paths", async () => {
  const cwd = await createGitRepo();
  try {
    const missing = await captureRepositoryResumeContext(cwd, ["optional/input.txt"]);
    assert.equal(missing.kind, "verified");
    assert.deepEqual(await captureRepositoryResumeContext(cwd, ["optional/input.txt"]), missing);

    await mkdir(join(cwd, "optional"), { recursive: true });
    await writeFile(join(cwd, "optional", "input.txt"), "present\n", "utf8");
    const present = await captureRepositoryResumeContext(cwd, ["optional/input.txt"]);
    assert.equal(present.kind, "verified");
    if (missing.kind !== "verified" || present.kind !== "verified") assert.fail("expected verified contexts");
    assert.notEqual(present.workingTreeFingerprint, missing.workingTreeFingerprint);

    const escaped = await captureRepositoryResumeContext(cwd, ["../outside.txt"]);
    assert.equal(escaped.kind, "unverifiable");
    if (escaped.kind !== "unverifiable") assert.fail("expected escaped input rejection");
    assert.match(escaped.reason, /escapes the repository root/);

    const gitControl = await captureRepositoryResumeContext(cwd, [".git/config"]);
    assert.equal(gitControl.kind, "unverifiable");
    if (gitControl.kind !== "unverifiable") assert.fail("expected git control-path rejection");
    assert.match(gitControl.reason, /excluded path/);

    const journal = await captureRepositoryResumeContext(cwd, [".pi/.workflow-runs/run.jsonl"]);
    assert.equal(journal.kind, "unverifiable");
    if (journal.kind !== "unverifiable") assert.fail("expected workflow-journal rejection");
    assert.match(journal.reason, /excluded path/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("declared input fingerprint shares byte and entry bounds across all inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-declared-input-bounds-"));
  try {
    await writeFile(join(root, "first.txt"), "123", "utf8");
    await writeFile(join(root, "second.txt"), "456", "utf8");
    const bytes = await captureDeclaredInputFingerprint({
      root,
      inputs: ["first.txt", "second.txt"],
      maxBytes: 5,
      maxEntries: 10,
    });
    assert.equal(bytes.kind, "unverifiable");
    if (bytes.kind !== "unverifiable") assert.fail("expected shared byte bound rejection");
    assert.match(bytes.reason, /exceeded 5 bytes/);

    await mkdir(join(root, "tree"));
    await writeFile(join(root, "tree", "one.txt"), "1", "utf8");
    await writeFile(join(root, "tree", "two.txt"), "2", "utf8");
    const entries = await captureDeclaredInputFingerprint({
      root,
      inputs: ["tree"],
      maxBytes: 100,
      maxEntries: 2,
    });
    assert.equal(entries.kind, "unverifiable");
    if (entries.kind !== "unverifiable") assert.fail("expected shared entry bound rejection");
    assert.match(entries.reason, /exceeded 2 entries/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file workflow provenance is revalidated against its load-time tree fingerprint", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-source-context-"));
  const sourcePath = join(root, "workflow.ts");
  const helperPath = join(root, "helper.ts");
  try {
    await writeFile(sourcePath, 'import "./helper.ts";\n', "utf8");
    await writeFile(helperPath, "export const value = 'one';\n", "utf8");
    const loaded = await captureTreeFingerprint({ root, maxBytes: 1 << 20, maxFiles: 32 });
    assert.equal(loaded.kind, "verified");
    if (loaded.kind !== "verified") assert.fail("expected source fixture fingerprint");
    const workflow: LoadedWorkflow = {
      meta: { name: "source-context", description: "" },
      default: async () => "ok",
      source: { kind: "file", path: sourcePath, root, fingerprint: loaded.fingerprint },
    };
    const first = await captureWorkflowResumeContext(workflow);
    assert.equal(first.kind, "verified");

    await writeFile(helperPath, "export const value = 'two';\n", "utf8");
    const changed = await captureWorkflowResumeContext(workflow);
    assert.deepEqual(changed, {
      kind: "unverifiable",
      name: "source-context",
      reason: "workflow source tree changed after the module loaded",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tree fingerprints and file validation reject symlinks and the root directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-tree-safety-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-workflow-tree-outside-"));
  try {
    await writeFile(join(outside, "input.txt"), "outside\n", "utf8");
    await symlink(join(outside, "input.txt"), join(root, "linked.txt"));
    const capture = await captureTreeFingerprint({ root, maxBytes: 1 << 20, maxFiles: 32 });
    assert.equal(capture.kind, "unverifiable");
    if (capture.kind !== "unverifiable") assert.fail("expected symlink tree to be rejected");
    assert.match(capture.reason, /symbolic link/);

    assert.deepEqual(await validateTreeFile({ root, path: root }), {
      kind: "unverifiable",
      reason: "fingerprint source resolves to its root directory",
    });
    assert.equal(isPathWithin(root, join(root, "..inside", "file.ts")), true);
    assert.equal(isPathWithin(root, join(root, "..", "outside.ts")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("agent resume identity preserves ordered skills and effective tools", () => {
  const base = {
    workflow: { kind: "verified", name: "review", sourceFingerprint: "workflow" },
  } as const;
  const repository = { kind: "verified", state: "git", head: "head", workingTreeFingerprint: "tree" } as const;
  const skills = [
    { name: "beta", path: "skills/beta", fingerprint: "beta" },
    { name: "alpha", path: "skills/alpha", fingerprint: "alpha" },
  ] as const;
  const tools = [
    {
      name: "write",
      definitionFingerprint: "definition-write",
      implementationFingerprint: "implementation-write",
      source: { path: "builtin:write", source: "builtin", scope: "temporary", origin: "top-level", fingerprint: "source-write" },
    },
    {
      name: "read",
      definitionFingerprint: "definition-read",
      implementationFingerprint: "implementation-read",
      source: { path: "builtin:read", source: "builtin", scope: "temporary", origin: "top-level", fingerprint: "source-read" },
    },
  ] as const;
  const session = {
    fingerprint: "session",
    runtimeVersion: "runtime",
    systemPromptFingerprint: "prompt",
    model: { provider: "test", id: "model" },
    thinkingLevel: "low",
    tools,
  } as const;
  const ordered = createAgentResumeContext(base, repository, session, skills);
  assert.deepEqual(ordered.skills.map((skill) => skill.name), ["beta", "alpha"]);
  assert.deepEqual(ordered.session.tools.map((tool) => tool.name), ["write", "read"]);
  assert.equal(
    resumeContextMismatchReason(ordered, { ...ordered, skills: [...ordered.skills].reverse() }),
    "resolved skills changed",
  );

  assert.equal(
    resumeContextMismatchReason(ordered, {
      ...ordered,
      session: { ...ordered.session, tools: [...ordered.session.tools].reverse() },
    }),
    "effective tools or session state changed",
  );
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
        source: { kind: "file", path: sourcePath, root, fingerprint: "unused-outside-root" },
      },
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
        source: {
          kind: "file",
          path: join(root, "linked", "workflow.ts"),
          root,
          fingerprint: "unused-symlink-source",
        },
      },
    );
    assert.equal(context.kind, "unverifiable");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
