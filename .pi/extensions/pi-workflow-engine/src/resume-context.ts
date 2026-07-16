import { lstat, readlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { throwIfAborted } from "./cancellation.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.ts";
import {
  BoundedFingerprint,
  captureTreeFingerprint,
  isPathWithin,
  validateTreeFile,
  type FingerprintCapture,
} from "./tree-fingerprint.ts";
import type { LoadedWorkflow } from "./types.ts";

export type RepositoryResumeContext =
  | {
      readonly kind: "verified";
      readonly state: "git";
      readonly head: string;
      readonly workingTreeFingerprint: string;
    }
  | {
      readonly kind: "verified";
      readonly state: "unborn" | "non-git";
      readonly workingTreeFingerprint: string;
    }
  | { readonly kind: "unverifiable"; readonly reason: string };

export type WorkflowResumeContext =
  | { readonly kind: "verified"; readonly name: string; readonly sourceFingerprint: string }
  | { readonly kind: "unverifiable"; readonly name: string; readonly reason: string };

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

export type WorkflowSourceFingerprintCache = Map<string, Promise<FingerprintCapture>>;

type RepositoryRevision =
  | { readonly state: "git"; readonly head: string }
  | { readonly state: "unborn" };

type BoundedProcessFailureResult = Extract<BoundedProcessResult, { readonly ok: false }>;

const GIT_CONTEXT_TIMEOUT_MS = 15_000;
const GIT_CONTEXT_MAX_BYTES = 32 << 20;
const CONTENT_FINGERPRINT_MAX_BYTES = 32 << 20;
const SOURCE_TREE_MAX_FILES = 4096;
const REPOSITORY_PATHSPEC = ":(top)**";
const WORKFLOW_JOURNAL_DIR = ".pi/.workflow-runs";
const FINGERPRINT_EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".idea", ".artifacts", ".workflow-runs", "node_modules", "coverage"]);

export function createWorkflowSourceFingerprintCache(): WorkflowSourceFingerprintCache {
  return new Map();
}

export function unverifiableRepositoryResumeContext(reason: string): RepositoryResumeContext {
  return { kind: "unverifiable", reason };
}

export function unverifiableWorkflowResumeContext(name: string, reason: string): WorkflowResumeContext {
  return { kind: "unverifiable", name, reason };
}

export async function captureRepositoryResumeContext(cwd: string, signal?: AbortSignal): Promise<RepositoryResumeContext> {
  throwIfAborted(signal);
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  throwIfAborted(signal);

  if (!probe.ok) {
    if (probe.failure.kind === "exit") {
      const marker = await findGitControlPath(cwd, signal);
      if (marker.kind === "absent") return await captureNonGitRepositoryContext(cwd, signal);
      if (marker.kind === "unknown") return unverifiableRepositoryResumeContext(marker.reason);
    }
    return unverifiableRepositoryResumeContext(processFailureReason("git repository probe", probe));
  }

  const insideWorkTree = probe.stdout.trim();
  if (insideWorkTree === "false") return await captureNonGitRepositoryContext(cwd, signal);
  if (insideWorkTree !== "true") {
    return unverifiableRepositoryResumeContext(`git repository probe returned an unexpected value: ${insideWorkTree || "<empty>"}`);
  }

  const headResult = await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], signal);
  throwIfAborted(signal);
  let revision: RepositoryRevision;
  if (headResult.ok) {
    const head = headResult.stdout.trim();
    if (!head) return unverifiableRepositoryResumeContext("git HEAD probe returned an empty revision");
    revision = { state: "git", head };
  } else if (headResult.failure.kind === "exit" && headResult.failure.code === 1) {
    revision = { state: "unborn" };
  } else {
    return unverifiableRepositoryResumeContext(processFailureReason("git HEAD probe", headResult));
  }

  const prefixResult = await runGit(cwd, ["rev-parse", "--show-prefix"], signal);
  throwIfAborted(signal);
  if (!prefixResult.ok) return unverifiableRepositoryResumeContext(processFailureReason("git prefix probe", prefixResult));

  const dirty = await captureDirtyFingerprint(cwd, prefixResult.stdout.replace(/\r?\n$/, ""), signal);
  if (dirty.kind === "unverifiable") return unverifiableRepositoryResumeContext(dirty.reason);
  return { kind: "verified", ...revision, workingTreeFingerprint: dirty.fingerprint };
}

async function captureNonGitRepositoryContext(cwd: string, signal: AbortSignal | undefined): Promise<RepositoryResumeContext> {
  const capture = await captureTreeFingerprint({
    root: cwd,
    excludedDirectoryNames: FINGERPRINT_EXCLUDED_DIRECTORY_NAMES,
    maxBytes: CONTENT_FINGERPRINT_MAX_BYTES,
    maxFiles: SOURCE_TREE_MAX_FILES,
    signal,
  });
  return capture.kind === "verified"
    ? { kind: "verified", state: "non-git", workingTreeFingerprint: capture.fingerprint }
    : unverifiableRepositoryResumeContext(capture.reason);
}

export async function captureWorkflowResumeContext(
  mod: LoadedWorkflow,
  sourceFingerprintCache: WorkflowSourceFingerprintCache,
  signal?: AbortSignal,
): Promise<WorkflowResumeContext> {
  throwIfAborted(signal);
  if (mod.source.kind === "unverifiable") {
    return unverifiableWorkflowResumeContext(mod.meta.name, mod.source.reason);
  }
  if (mod.source.kind === "fingerprint") {
    return mod.source.fingerprint.length > 0
      ? { kind: "verified", name: mod.meta.name, sourceFingerprint: mod.source.fingerprint }
      : unverifiableWorkflowResumeContext(mod.meta.name, "workflow source fingerprint is empty");
  }

  const sourcePath = resolve(mod.source.path);
  const sourceRoot = resolve(mod.source.root);
  if (!isPathWithin(sourceRoot, sourcePath)) {
    return unverifiableWorkflowResumeContext(mod.meta.name, "workflow source file is outside its declared source root");
  }
  const sourceValidation = await validateTreeFile({
    root: sourceRoot,
    path: sourcePath,
    excludedDirectoryNames: FINGERPRINT_EXCLUDED_DIRECTORY_NAMES,
    signal,
  });
  if (sourceValidation.kind === "unverifiable") {
    return unverifiableWorkflowResumeContext(mod.meta.name, `workflow source file is not part of its source tree: ${sourceValidation.reason}`);
  }

  let capture = sourceFingerprintCache.get(sourceRoot);
  if (!capture) {
    capture = captureTreeFingerprint({
      root: sourceRoot,
      excludedDirectoryNames: FINGERPRINT_EXCLUDED_DIRECTORY_NAMES,
      maxBytes: CONTENT_FINGERPRINT_MAX_BYTES,
      maxFiles: SOURCE_TREE_MAX_FILES,
      signal,
    });
    sourceFingerprintCache.set(sourceRoot, capture);
  }

  let fingerprint: FingerprintCapture;
  try {
    fingerprint = await capture;
  } catch (error) {
    if (sourceFingerprintCache.get(sourceRoot) === capture) sourceFingerprintCache.delete(sourceRoot);
    throw error;
  }
  return fingerprint.kind === "verified"
    ? { kind: "verified", name: mod.meta.name, sourceFingerprint: fingerprint.fingerprint }
    : unverifiableWorkflowResumeContext(mod.meta.name, fingerprint.reason);
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

export function resumeContextMismatchReason(stored: AgentResumeContext, current: AgentResumeContext): string | undefined {
  if (stored.repository.kind === "unverifiable" || current.repository.kind === "unverifiable") {
    return "repository context could not be verified";
  }
  if (stored.repository.state !== current.repository.state) return "repository state changed";
  if (
    stored.repository.state === "git" &&
    current.repository.state === "git" &&
    stored.repository.head !== current.repository.head
  ) {
    return "repository HEAD changed";
  }
  if (stored.repository.workingTreeFingerprint !== current.repository.workingTreeFingerprint) {
    return "working tree contents changed";
  }
  if (stored.workflow.kind === "unverifiable" || current.workflow.kind === "unverifiable") {
    return "workflow source could not be verified";
  }
  if (stored.workflow.name !== current.workflow.name) return "workflow name changed";
  if (stored.workflow.sourceFingerprint !== current.workflow.sourceFingerprint) return "workflow source changed";
  if (stored.model?.provider !== current.model?.provider || stored.model?.id !== current.model?.id) return "effective model changed";
  return undefined;
}

export function isAgentResumeContext(value: unknown): value is AgentResumeContext {
  if (!isRecord(value)) return false;
  return isRepositoryResumeContext(value.repository) && isWorkflowResumeContext(value.workflow) && isResolvedModelIdentity(value.model);
}

async function captureDirtyFingerprint(
  cwd: string,
  repoPrefix: string,
  signal: AbortSignal | undefined,
): Promise<FingerprintCapture> {
  const journalExclude = `:(top,exclude,literal)${repoPrefix}${WORKFLOW_JOURNAL_DIR}`;
  const [status, staged, unstaged, untracked] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-color", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["diff", "--binary", "--no-ext-diff", "--no-color", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", REPOSITORY_PATHSPEC, journalExclude], signal),
  ]);
  const failed = [status, staged, unstaged, untracked].find((result) => !result.ok);
  if (failed && !failed.ok) return { kind: "unverifiable", reason: processFailureReason("git working-tree capture", failed) };

  const fingerprint = new BoundedFingerprint(CONTENT_FINGERPRINT_MAX_BYTES);
  fingerprint.add("status", status.stdout);
  fingerprint.add("staged", staged.stdout);
  fingerprint.add("unstaged", unstaged.stdout);

  try {
    const paths = untracked.stdout.split("\0").filter((path) => path.length > 0).sort();
    for (const path of paths) {
      throwIfAborted(signal);
      const fullPath = join(cwd, path);
      const info = await lstat(fullPath);
      fingerprint.add("untracked-path", path);
      if (info.isSymbolicLink()) {
        fingerprint.add("symlink", await readlink(fullPath));
      } else if (info.isFile()) {
        await fingerprint.addFile("file", fullPath, signal);
      } else {
        throw new Error(`untracked path is not a regular file or symbolic link: ${path}`);
      }
    }
    return { kind: "verified", fingerprint: fingerprint.digest() };
  } catch (error) {
    throwIfAborted(signal);
    return { kind: "unverifiable", reason: errorMessage(error) };
  }
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

type GitControlPathResult =
  | { readonly kind: "present" | "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

async function findGitControlPath(cwd: string, signal: AbortSignal | undefined): Promise<GitControlPathResult> {
  let current = resolve(cwd);
  while (true) {
    throwIfAborted(signal);
    try {
      await lstat(join(current, ".git"));
      return { kind: "present" };
    } catch (error) {
      if (!isMissingPathError(error)) {
        return { kind: "unknown", reason: `git control-path probe failed: ${errorMessage(error)}` };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { kind: "absent" };
    current = parent;
  }
}

function processFailureReason(operation: string, result: BoundedProcessFailureResult): string {
  if (result.failure.kind === "exit") {
    const termination = result.failure.code === null ? `signal ${result.failure.signal ?? "unknown"}` : `exit ${result.failure.code}`;
    const message = sanitizeProcessMessage(result.failure.message);
    return `${operation} failed (${termination}${message ? `: ${message}` : ""})`;
  }
  return `${operation} failed (${result.failure.kind}: ${result.failure.message})`;
}

function isRepositoryResumeContext(value: unknown): value is RepositoryResumeContext {
  if (!isRecord(value)) return false;
  if (value.kind === "unverifiable") return typeof value.reason === "string";
  if (value.kind !== "verified" || typeof value.workingTreeFingerprint !== "string") return false;
  if (value.state === "git") return typeof value.head === "string";
  return value.state === "unborn" || value.state === "non-git";
}

function isWorkflowResumeContext(value: unknown): value is WorkflowResumeContext {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.kind === "unverifiable") return typeof value.reason === "string";
  return value.kind === "verified" && typeof value.sourceFingerprint === "string";
}

function isResolvedModelIdentity(value: unknown): value is ResolvedModelIdentity | null {
  return value === null || (isRecord(value) && typeof value.provider === "string" && typeof value.id === "string");
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeProcessMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, 500);
}
