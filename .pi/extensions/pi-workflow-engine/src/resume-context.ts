import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { throwIfAborted } from "./cancellation.ts";
import type { WorkflowModule } from "./types.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.ts";

export interface RepositoryResumeContext {
  readonly state: "git" | "unborn" | "non-git";
  readonly head: string;
  readonly dirtyFingerprint: string;
  readonly verifiable: boolean;
}

export interface WorkflowResumeContext {
  readonly name: string;
  readonly sourceFingerprint: string;
  readonly verifiable: boolean;
}

export interface ResolvedModelIdentity {
  readonly provider: string;
  readonly id: string;
}

export interface AgentResumeBaseContext {
  readonly repository: RepositoryResumeContext;
  readonly workflow: WorkflowResumeContext;
}

export interface AgentResumeContext extends AgentResumeBaseContext {
  readonly model: ResolvedModelIdentity | null;
}

const GIT_CONTEXT_TIMEOUT_MS = 15_000;
const GIT_CONTEXT_MAX_BYTES = 32 << 20;
const CONTENT_FINGERPRINT_MAX_BYTES = 32 << 20;
const SOURCE_TREE_MAX_FILES = 4096;
const SOURCE_TREE_MAX_ANCESTORS = 32;
const REPOSITORY_PATHSPEC = ":(top)**";
const WORKFLOW_JOURNAL_DIR = ".pi/.workflow-runs";
const SOURCE_TREE_EXCLUDED_DIRECTORIES = new Set([".git", ".idea", ".artifacts", ".workflow-runs", "node_modules", "coverage"]);

export function nonGitRepositoryResumeContext(): RepositoryResumeContext {
  return unverifiableRepositoryResumeContext("non-git", "non-git");
}

export async function captureRepositoryResumeContext(cwd: string, signal?: AbortSignal): Promise<RepositoryResumeContext> {
  throwIfAborted(signal);
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  throwIfAborted(signal);
  if (!probe.ok) {
    if (await isGenuineNonGitDirectory(cwd, probe, signal)) return await captureNonGitRepositoryContext(cwd, signal);
    return unverifiableRepositoryResumeContext("non-git", "non-git");
  }
  if (probe.stdout.trim() !== "true") return await captureNonGitRepositoryContext(cwd, signal);

  const headResult = await runGit(cwd, ["rev-parse", "--verify", "HEAD"], signal);
  throwIfAborted(signal);
  if (!headResult.ok && !isExpectedUnbornHeadFailure(headResult)) {
    return unverifiableRepositoryResumeContext("unborn", "unborn");
  }
  const state: RepositoryResumeContext["state"] = headResult.ok ? "git" : "unborn";
  const head = headResult.ok ? headResult.stdout.trim() : "unborn";
  const prefixResult = await runGit(cwd, ["rev-parse", "--show-prefix"], signal);
  throwIfAborted(signal);
  if (!prefixResult.ok) {
    return unverifiableRepositoryResumeContext(state, head);
  }
  const repoPrefix = prefixResult.stdout.replace(/\r?\n$/, "");
  const dirty = await captureDirtyFingerprint(cwd, repoPrefix, signal);
  return {
    state,
    head,
    dirtyFingerprint: dirty.fingerprint,
    verifiable: dirty.verifiable,
  };
}

async function captureNonGitRepositoryContext(cwd: string, signal: AbortSignal | undefined): Promise<RepositoryResumeContext> {
  try {
    const root = resolve(cwd);
    const hash = createHash("sha256");
    const directories = [root];
    let contentBytes = 0;
    let fileCount = 0;

    while (directories.length > 0) {
      throwIfAborted(signal);
      const directory = directories.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        const path = join(directory, entry.name);
        const relativePath = relative(root, path);
        if (entry.isDirectory()) {
          if (!SOURCE_TREE_EXCLUDED_DIRECTORIES.has(entry.name)) directories.push(path);
          continue;
        }
        fileCount += 1;
        if (fileCount > SOURCE_TREE_MAX_FILES) throw new Error(`non-git repository exceeds ${SOURCE_TREE_MAX_FILES} files`);
        addHashPart(hash, "path", relativePath);
        if (entry.isSymbolicLink()) {
          addHashPart(hash, "symlink", await readlink(path));
          continue;
        }
        if (!entry.isFile()) throw new Error(`non-git repository contains an unverifiable entry: ${path}`);
        const info = await lstat(path);
        addHashPart(hash, "mode", String(info.mode));
        contentBytes += await addFileHashPart(
          hash,
          "file",
          path,
          CONTENT_FINGERPRINT_MAX_BYTES - contentBytes,
          signal,
        );
      }
    }

    return {
      state: "non-git",
      head: "non-git",
      dirtyFingerprint: hash.digest("hex"),
      verifiable: true,
    };
  } catch {
    throwIfAborted(signal);
    return unverifiableRepositoryResumeContext("non-git", "non-git");
  }
}

export async function captureWorkflowResumeContext(mod: WorkflowModule, signal?: AbortSignal): Promise<WorkflowResumeContext> {
  throwIfAborted(signal);
  if (mod.source?.kind === "fingerprint") {
    return {
      name: mod.meta.name,
      sourceFingerprint: mod.source.fingerprint,
      verifiable: mod.source.fingerprint.length > 0,
    };
  }
  if (mod.source?.kind === "file") {
    const source = await captureWorkflowFileFingerprint(mod.source.path, signal);
    return { name: mod.meta.name, sourceFingerprint: source.fingerprint, verifiable: source.verifiable };
  }
  return {
    name: mod.meta.name,
    sourceFingerprint: sha256(`unverifiable-workflow-source\0${randomUUID()}`),
    verifiable: false,
  };
}

export function createAgentResumeContext(
  base: AgentResumeBaseContext,
  model: ResolvedModelIdentity | undefined,
): AgentResumeContext {
  return {
    ...base,
    model: model ? { provider: model.provider, id: model.id } : null,
  };
}

async function captureDirtyFingerprint(
  cwd: string,
  repoPrefix: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly fingerprint: string; readonly verifiable: boolean }> {
  const journalExclude = `:(top,exclude,literal)${repoPrefix}${WORKFLOW_JOURNAL_DIR}`;
  const [status, staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["diff", "--binary", "--no-ext-diff", "--no-color", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
  ]);
  const commands = [status, staged, unstaged, untracked];
  if (commands.some((result) => !result.ok)) {
    return { fingerprint: sha256(`unverifiable\0${randomUUID()}`), verifiable: false };
  }

  const hash = createHash("sha256");
  addHashPart(hash, "status", status.stdout);
  addHashPart(hash, "staged", staged.stdout);
  addHashPart(hash, "unstaged", unstaged.stdout);

  const paths = untracked.stdout.split("\0").filter((path) => path.length > 0).sort();
  let contentBytes = 0;
  try {
    for (const path of paths) {
      throwIfAborted(signal);
      const fullPath = join(cwd, path);
      const info = await lstat(fullPath);
      addHashPart(hash, "untracked-path", path);
      if (info.isSymbolicLink()) {
        throwIfAborted(signal);
        addHashPart(hash, "symlink", await readlink(fullPath));
      } else if (info.isFile()) {
        contentBytes += await addFileHashPart(
          hash,
          "file",
          fullPath,
          CONTENT_FINGERPRINT_MAX_BYTES - contentBytes,
          signal,
        );
      } else {
        addHashPart(hash, "other", `${info.mode}:${info.size}`);
      }
    }
  } catch {
    throwIfAborted(signal);
    return { fingerprint: sha256(`unverifiable\0${randomUUID()}`), verifiable: false };
  }
  return { fingerprint: hash.digest("hex"), verifiable: true };
}

async function runGit(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<BoundedProcessResult> {
  return await runBoundedProcess({
    file: "git",
    args,
    cwd,
    signal,
    timeoutMs: GIT_CONTEXT_TIMEOUT_MS,
    maxBufferBytes: GIT_CONTEXT_MAX_BYTES,
    abortError: "git resume-context capture aborted",
    timeoutError: `git resume-context capture timed out after ${GIT_CONTEXT_TIMEOUT_MS}ms`,
    maxBufferError: `git resume-context capture exceeded ${GIT_CONTEXT_MAX_BYTES} bytes`,
    exitError: (stderr, code, exitSignal) => stderr.trim() || `git exited with code ${code ?? `signal ${exitSignal ?? "unknown"}`}`,
  });
}

async function captureWorkflowFileFingerprint(
  sourcePath: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly fingerprint: string; readonly verifiable: boolean }> {
  try {
    const absoluteSourcePath = resolve(sourcePath);
    const sourceRoot = await findSourceTreeRoot(absoluteSourcePath, signal);
    const hash = createHash("sha256");
    const directories = [sourceRoot];
    let contentBytes = 0;
    let fileCount = 0;
    let sourceSeen = false;

    while (directories.length > 0) {
      throwIfAborted(signal);
      const directory = directories.pop()!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal);
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SOURCE_TREE_EXCLUDED_DIRECTORIES.has(entry.name)) directories.push(path);
          continue;
        }
        if (!entry.isFile()) throw new Error(`workflow source tree contains an unverifiable entry: ${path}`);
        if (resolve(path) === absoluteSourcePath) sourceSeen = true;
        fileCount += 1;
        if (fileCount > SOURCE_TREE_MAX_FILES) throw new Error(`workflow source tree exceeds ${SOURCE_TREE_MAX_FILES} files`);
        addHashPart(hash, "source-path", relative(sourceRoot, path));
        contentBytes += await addFileHashPart(
          hash,
          "source-file",
          path,
          CONTENT_FINGERPRINT_MAX_BYTES - contentBytes,
          signal,
        );
      }
    }

    if (!isPathWithin(sourceRoot, absoluteSourcePath) || !sourceSeen) {
      throw new Error("workflow source file is missing from its source tree");
    }
    return { fingerprint: hash.digest("hex"), verifiable: true };
  } catch {
    throwIfAborted(signal);
    return { fingerprint: sha256(`unverifiable-workflow-file\0${sourcePath}\0${randomUUID()}`), verifiable: false };
  }
}

async function findSourceTreeRoot(sourcePath: string, signal: AbortSignal | undefined): Promise<string> {
  let current = dirname(sourcePath);
  for (let depth = 0; depth < SOURCE_TREE_MAX_ANCESTORS; depth++) {
    throwIfAborted(signal);
    try {
      if ((await stat(join(current, "package.json"))).isFile()) return current;
    } catch {
      // Keep walking to the nearest package boundary.
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("workflow source has no bounded package root");
    current = parent;
  }
  throw new Error(`workflow package root exceeds ${SOURCE_TREE_MAX_ANCESTORS} ancestors`);
}

async function addFileHashPart(
  hash: ReturnType<typeof createHash>,
  label: string,
  path: string,
  maxBytes: number,
  signal: AbortSignal | undefined,
): Promise<number> {
  if (maxBytes < 0) throw new Error("resume-context content fingerprint exceeded its byte limit");
  hash.update(label);
  hash.update("\0");
  let bytes = 0;
  const stream = createReadStream(path, { highWaterMark: 64 << 10, signal });
  try {
    for await (const chunk of stream) {
      throwIfAborted(signal);
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      bytes += buffer.length;
      if (bytes > maxBytes) {
        stream.destroy();
        throw new Error(`resume-context content fingerprint exceeded ${CONTENT_FINGERPRINT_MAX_BYTES} bytes`);
      }
      hash.update(buffer);
    }
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  hash.update("\0");
  return bytes;
}

async function isGenuineNonGitDirectory(
  cwd: string,
  probe: BoundedProcessResult,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  const stderr = probe.stderr.trim();
  // Operational failures (spawn, abort, timeout, or output limit) set an error
  // that differs from Git's stderr. Only Git's own non-repository exit is stable.
  if (probe.error !== stderr || !/not a git repository/i.test(stderr)) return false;

  let current = resolve(cwd);
  while (true) {
    throwIfAborted(signal);
    try {
      await lstat(join(current, ".git"));
      return false;
    } catch (error) {
      if (!isMissingPathError(error)) return false;
    }
    const parent = dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

function isExpectedUnbornHeadFailure(result: BoundedProcessResult): boolean {
  const message = `${result.stderr}\n${result.error ?? ""}`;
  return /needed a single revision|unknown revision.*HEAD|ambiguous argument ['"]?HEAD/i.test(message);
}

function unverifiableRepositoryResumeContext(
  state: RepositoryResumeContext["state"],
  head: string,
): RepositoryResumeContext {
  return {
    state,
    head,
    dirtyFingerprint: sha256(`unverifiable\0${randomUUID()}`),
    verifiable: false,
  };
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isPathWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.startsWith("/"));
}

function addHashPart(hash: ReturnType<typeof createHash>, label: string, value: string | Buffer): void {
  hash.update(label);
  hash.update("\0");
  hash.update(value);
  hash.update("\0");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
