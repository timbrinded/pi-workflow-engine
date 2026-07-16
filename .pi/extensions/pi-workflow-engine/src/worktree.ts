import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { runBoundedProcess } from "./process-runner.ts";

export interface WorktreeGitCommandOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly stdin?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
}

export interface WorktreeGitCommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface WorktreeGitRunner {
  runGit(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult>;
}

export interface WorktreeRef {
  readonly path: string;
  readonly snapshot?: boolean;
}

/** Immutable commit plus an optional patch used to reconstruct a reviewed snapshot. */
export interface WorktreeBaseline {
  readonly ref?: string;
  readonly patch?: string;
}

export interface WorktreeAddFailure {
  readonly path: string;
  readonly error: string;
  readonly snapshot?: boolean;
  readonly cleanup?: WorktreeGitCommandResult;
}

export interface GitWorktreeProbe {
  readonly ok: boolean;
  readonly inside: boolean;
  readonly error?: string;
}

export interface WorktreeRemovalOutcome extends WorktreeGitCommandResult {
  readonly path: string;
}

export interface WorktreePatch {
  readonly patch: string;
  readonly changed: boolean;
}

export interface WorktreeRegistryOptions {
  readonly repoCwd: string;
  readonly runner?: WorktreeGitRunner;
  readonly patchCapture?: WorktreePatchCapture;
  readonly timeoutMs?: number;
}

export type WorktreePatchCapture = (options: {
  readonly worktreePath: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}) => Promise<WorktreePatch | { readonly error: string }>;

const DEFAULT_WORKTREE_TIMEOUT_MS = 30_000;
const WORKTREE_DIFF_MAX_BYTES = 16 << 20;
let pathCounter = 0;

export class WorktreeRegistry {
  private readonly paths = new Set<string>();
  private readonly snapshots = new Set<string>();
  private readonly runner: WorktreeGitRunner;
  private readonly patchCapture: WorktreePatchCapture;
  private readonly timeoutMs: number;

  constructor(private readonly repoCwd: string, options: Omit<WorktreeRegistryOptions, "repoCwd"> = {}) {
    this.runner = options.runner ?? spawnGitRunner;
    this.patchCapture = options.patchCapture ?? captureWorktreePatch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  }

  get size(): number {
    return this.paths.size;
  }

  register(path: string): void {
    this.paths.add(path);
  }

  async probe(signal?: AbortSignal): Promise<GitWorktreeProbe> {
    return await isGitWorktree({ repoCwd: this.repoCwd, runner: this.runner, signal, timeoutMs: this.timeoutMs });
  }

  async add(signal?: AbortSignal, baseline?: WorktreeBaseline): Promise<WorktreeRef | WorktreeAddFailure> {
    const added = await addWorktree({ repoCwd: this.repoCwd, runner: this.runner, signal, timeoutMs: this.timeoutMs, baseline });
    this.register(added.path);
    if (added.snapshot === true) this.snapshots.add(added.path);
    if ("error" in added) {
      const cleanup = await this.remove(added.path);
      return { ...added, cleanup };
    }
    return added;
  }

  async capturePatch(path: string, signal?: AbortSignal): Promise<WorktreePatch | { readonly error: string }> {
    return await this.patchCapture({ worktreePath: path, runner: this.runner, signal, timeoutMs: this.timeoutMs });
  }

  async remove(path: string): Promise<WorktreeGitCommandResult> {
    const result = await removeWorktree({ repoCwd: this.repoCwd, path, runner: this.runner, timeoutMs: this.timeoutMs, snapshot: this.snapshots.has(path) }).catch((error: unknown) => ({
      ok: false,
      stdout: "",
      stderr: "",
      error: formatError(error),
    }));
    if (result.ok) {
      this.paths.delete(path);
      this.snapshots.delete(path);
    }
    return result;
  }

  async removeAll(): Promise<readonly WorktreeRemovalOutcome[]> {
    return await Promise.all(
      [...this.paths].map(async (path) => ({
        path,
        ...(await this.remove(path)),
      })),
    );
  }
}

export function createWorktreePath(baseDir = tmpdir()): string {
  pathCounter += 1;
  return join(baseDir, `pi-workflow-${process.pid}-${pathCounter}-${randomUUID()}`);
}

export async function isGitWorktree(options: {
  readonly repoCwd: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<GitWorktreeProbe> {
  const result = await (options.runner ?? spawnGitRunner)
    .runGit({
      cwd: options.repoCwd,
      args: ["rev-parse", "--is-inside-work-tree"],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: formatError(error) }));
  if (!result.ok) return { ok: false, inside: false, error: result.error ?? (result.stderr.trim() || "git worktree probe failed") };
  return { ok: true, inside: result.stdout.trim() === "true" };
}

export async function addWorktree(options: {
  readonly repoCwd: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly baseDir?: string;
  readonly baseline?: WorktreeBaseline;
}): Promise<WorktreeRef | WorktreeAddFailure> {
  const path = createWorktreePath(options.baseDir);
  const ref = options.baseline?.ref ?? "HEAD";
  const result = await (options.runner ?? spawnGitRunner)
    .runGit({
      cwd: options.repoCwd,
      args: ["worktree", "add", "--detach", path, ref],
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: formatError(error) }));
  if (result.ok) {
    const patch = options.baseline?.patch;
    if (patch !== undefined && patch.trim().length > 0) {
      const prepared = await prepareWorktreeBaseline({
        path,
        patch,
        runner: options.runner ?? spawnGitRunner,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
      }).catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: formatError(error) }));
      if (!prepared.ok) return { path, error: prepared.error ?? (prepared.stderr.trim() || "failed to prepare worktree baseline") };
    }
    return { path };
  }

  const message = result.error ?? (result.stderr.trim() || "git worktree add failed");
  if (!isInvalidHeadError(message)) return { path, error: message };

  const snapshotError = await createUnbornRepoSnapshot({ repoCwd: options.repoCwd, path, timeoutMs: options.timeoutMs, signal: options.signal })
    .then(() => undefined)
    .catch((error: unknown) => formatError(error));
  if (snapshotError !== undefined) return { path, snapshot: true, error: `git worktree add failed (${message}); unborn-repo snapshot fallback failed: ${snapshotError}` };
  return { path, snapshot: true };
}

async function prepareWorktreeBaseline(options: {
  readonly path: string;
  readonly patch: string;
  readonly runner: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<WorktreeGitCommandResult> {
  const applied = await options.runner.runGit({
    cwd: options.path,
    args: ["apply", "--index", "--binary", "--whitespace=nowarn", "-"],
    stdin: options.patch,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  if (!applied.ok) return applied;
  const hooksPath = await mkdtemp(join(tmpdir(), "pi-workflow-empty-hooks-"));
  try {
    return await options.runner.runGit({
      cwd: options.path,
      args: [
        "-c",
        "user.name=pi-workflow",
        "-c",
        "user.email=pi-workflow@example.invalid",
        "-c",
        `core.hooksPath=${hooksPath}`,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "--no-verify",
        "--no-gpg-sign",
        "-m",
        "pi workflow reviewed snapshot",
      ],
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    await rm(hooksPath, { recursive: true, force: true });
  }
}

export async function removeWorktree(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly runner?: WorktreeGitRunner;
  readonly timeoutMs?: number;
  readonly snapshot?: boolean;
}): Promise<WorktreeGitCommandResult> {
  if (options.snapshot === true) {
    await rm(options.path, { recursive: true, force: true });
    return { ok: true, stdout: "", stderr: "" };
  }
  return await (options.runner ?? spawnGitRunner).runGit({
    cwd: options.repoCwd,
    args: ["worktree", "remove", "--force", options.path],
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
  });
}

export async function captureWorktreePatch(options: {
  readonly worktreePath: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<WorktreePatch | { readonly error: string }> {
  const runner = options.runner ?? spawnGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  const intentToAdd = await runner
    .runGit({
      cwd: options.worktreePath,
      args: ["add", "-N", "."],
      signal: options.signal,
      timeoutMs,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: formatError(error) }));
  if (!intentToAdd.ok) return { error: intentToAdd.error ?? (intentToAdd.stderr.trim() || "git add -N failed before patch capture") };

  const diff = await runner
    .runGit({
      cwd: options.worktreePath,
      args: ["diff", "--no-color", "HEAD"],
      signal: options.signal,
      timeoutMs,
      maxBufferBytes: WORKTREE_DIFF_MAX_BYTES,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: formatError(error) }));
  if (!diff.ok) return { error: diff.error ?? (diff.stderr.trim() || "worktree diff capture failed") };
  return { patch: diff.stdout, changed: diff.stdout.trim().length > 0 };
}

async function createUnbornRepoSnapshot(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<void> {
  const targetRoot = resolve(options.path);
  await rm(options.path, { recursive: true, force: true });
  await mkdir(options.path, { recursive: true });
  await cp(options.repoCwd, options.path, {
    recursive: true,
    force: true,
    filter: (source) => {
      const resolvedSource = resolve(source);
      if (resolvedSource === targetRoot || resolvedSource.startsWith(`${targetRoot}${sep}`)) return false;
      return !resolvedSource.split(/[\\/]/).includes(".git");
    },
  });
  await runGitCommand({ cwd: options.path, args: ["init"], signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS });
  await runGitCommand({ cwd: options.path, args: ["add", "-A"], signal: options.signal, timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS });
  await runGitCommand({
    cwd: options.path,
    args: ["-c", "user.name=pi-workflow", "-c", "user.email=pi-workflow@example.invalid", "commit", "--allow-empty", "-m", "pi workflow baseline"],
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
  });
}

function isInvalidHeadError(message: string): boolean {
  return /invalid reference:\s*HEAD/i.test(message) || /ambiguous argument ['"]?HEAD/i.test(message) || /unknown revision or path.*HEAD/i.test(message);
}

export const spawnGitRunner: WorktreeGitRunner = {
  async runGit(options) {
    return await runGitCommand(options);
  },
};

async function runGitCommand(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult> {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return await runBoundedProcess({
    file: "git",
    args: options.args,
    cwd: options.cwd,
    env,
    stdin: options.stdin,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    abortError: "git worktree command aborted",
    timeoutError: `git worktree command timed out after ${options.timeoutMs}ms`,
    maxBufferError: options.maxBufferBytes === undefined ? undefined : `git worktree command exceeded ${options.maxBufferBytes} bytes`,
    exitError: (stderr, code, signal) => stderr.trim() || `git exited with code ${code ?? `signal ${signal ?? "unknown"}`}`,
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
