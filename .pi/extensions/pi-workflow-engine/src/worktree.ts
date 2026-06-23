import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDiff } from "./diff-capture.ts";

export interface WorktreeGitCommandOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
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

  async isGitWorktree(signal?: AbortSignal): Promise<boolean> {
    return await isGitWorktree({ repoCwd: this.repoCwd, runner: this.runner, signal, timeoutMs: this.timeoutMs });
  }

  async add(signal?: AbortSignal): Promise<WorktreeRef | { readonly error: string }> {
    const added = await addWorktree({ repoCwd: this.repoCwd, runner: this.runner, signal, timeoutMs: this.timeoutMs });
    if (!("error" in added)) this.register(added.path);
    return added;
  }

  async capturePatch(path: string, signal?: AbortSignal): Promise<WorktreePatch | { readonly error: string }> {
    return await this.patchCapture({ worktreePath: path, runner: this.runner, signal, timeoutMs: this.timeoutMs });
  }

  async remove(path: string): Promise<WorktreeGitCommandResult> {
    const result = await removeWorktree({ repoCwd: this.repoCwd, path, runner: this.runner, timeoutMs: this.timeoutMs });
    if (result.ok) this.paths.delete(path);
    return result;
  }

  async removeAll(): Promise<void> {
    await Promise.all([...this.paths].map((path) => this.remove(path).catch(() => undefined)));
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
}): Promise<boolean> {
  const result = await (options.runner ?? spawnGitRunner).runGit({
    cwd: options.repoCwd,
    args: ["rev-parse", "--is-inside-work-tree"],
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
  });
  return result.ok && result.stdout.trim() === "true";
}

export async function addWorktree(options: {
  readonly repoCwd: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly baseDir?: string;
}): Promise<WorktreeRef | { readonly error: string }> {
  const path = createWorktreePath(options.baseDir);
  const result = await (options.runner ?? spawnGitRunner).runGit({
    cwd: options.repoCwd,
    args: ["worktree", "add", "--detach", path, "HEAD"],
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS,
  });
  if (!result.ok) return { error: result.error ?? (result.stderr.trim() || "git worktree add failed") };
  return { path };
}

export async function removeWorktree(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly runner?: WorktreeGitRunner;
  readonly timeoutMs?: number;
}): Promise<WorktreeGitCommandResult> {
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
  const intentToAdd = await runner.runGit({
    cwd: options.worktreePath,
    args: ["add", "-N", "."],
    signal: options.signal,
    timeoutMs,
  });
  if (!intentToAdd.ok) return { error: intentToAdd.error ?? (intentToAdd.stderr.trim() || "git add -N failed before patch capture") };

  const diff = await captureDiff("git diff --no-color HEAD", {
    cwd: options.worktreePath,
    signal: options.signal,
    timeoutMs,
    maxBufferBytes: WORKTREE_DIFF_MAX_BYTES,
  });
  if (!diff.ok) return { error: diff.error ?? "worktree diff capture failed" };
  return { patch: diff.stdout, changed: diff.stdout.trim().length > 0 };
}

export const spawnGitRunner: WorktreeGitRunner = {
  async runGit(options) {
    return await runGitCommand(options);
  },
};

async function runGitCommand(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult> {
  let stdout = "";
  let stderr = "";
  let error: string | undefined;
  const child = spawn("git", [...options.args], {
    cwd: options.cwd,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<WorktreeGitCommandResult>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean, finishError?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok, stdout, stderr, error: finishError });
    };
    const kill = (message: string) => {
      error = error ?? message;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(false, error);
      }, 100);
    };
    const onAbort = () => kill("git worktree command aborted");
    const timeout = setTimeout(() => kill(`git worktree command timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    if (options.signal?.aborted) {
      kill("git worktree command aborted");
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (spawnError) => finish(false, spawnError.message));
    child.on("close", (code, signal) => {
      if (error) {
        finish(false, error);
        return;
      }
      if (code === 0) {
        finish(true);
        return;
      }
      finish(false, stderr.trim() || `git exited with code ${code ?? `signal ${signal ?? "unknown"}`}`);
    });
  });
}
