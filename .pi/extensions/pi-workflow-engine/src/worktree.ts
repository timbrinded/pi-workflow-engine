import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { GIT_DIFF_MACHINE_FORMAT, isGitObjectId, parseGitTopLevel, runGit, type GitCommandOptions } from "./git.ts";
import { FINGERPRINT_EXCLUDED_RELATIVE_PATHS, isExcludedDeclaredInput, portableRelativePath } from "./tree-fingerprint.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export type WorktreeGitCommandOptions = Omit<GitCommandOptions, "file" | "label">;

export type WorktreeGitCommandResult =
  | { readonly ok: true; readonly stdout: string; readonly stderr: string }
  | { readonly ok: false; readonly stdout: string; readonly stderr: string; readonly error: string };

export interface WorktreeGitRunner {
  runGit(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult>;
}

export interface WorktreeRef {
  readonly path: string;
  /** Exact post-setup commit used as the immutable base for every result patch. */
  readonly baselineOid: string;
  readonly snapshot?: boolean;
}

/** Immutable commit plus an optional patch used to reconstruct a reviewed snapshot. */
export interface WorktreeBaseline {
  readonly ref: string;
  readonly patch?: string;
}

export interface WorktreeAddFailure {
  readonly path: string;
  readonly error: string;
  readonly snapshot?: boolean;
  readonly cleanup?: WorktreeGitCommandResult;
}

export type GitWorktreeProbe = { readonly ok: true; readonly inside: boolean } | { readonly ok: false; readonly error: string };

export type WorktreeRemovalOutcome = WorktreeGitCommandResult & { readonly path: string };

export class WorktreeCleanupError extends AggregateError {
  readonly outcomes: readonly WorktreeRemovalOutcome[];

  constructor(outcomes: readonly WorktreeRemovalOutcome[]) {
    const failures = outcomes.filter((outcome) => !outcome.ok);
    const details = failures.map((failure) => `${failure.path} (${failure.error})`);
    super(
      failures.map((failure) => new Error(`Failed to remove isolated worktree ${failure.path}: ${failure.error}`)),
      `Failed to remove ${failures.length} isolated worktree${failures.length === 1 ? "" : "s"}: ${details.join(", ")}`,
    );
    this.name = "WorktreeCleanupError";
    this.outcomes = outcomes;
  }
}

export interface WorktreePatch {
  readonly patch: string;
  readonly changed: boolean;
}

export interface WorktreeRegistryOptions {
  readonly runner?: WorktreeGitRunner;
  readonly patchCapture?: WorktreePatchCapture;
  readonly timeoutMs?: number;
}

export type WorktreePatchCapture = (options: {
  readonly worktreePath: string;
  readonly baselineOid: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}) => Promise<WorktreePatch | { readonly error: string }>;

const DEFAULT_WORKTREE_TIMEOUT_MS = 30_000;
const WORKTREE_DIFF_MAX_BYTES = 16 << 20;
const SYNTHETIC_COMMIT_ENV: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "pi-workflow",
  GIT_AUTHOR_EMAIL: "pi-workflow@example.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "pi-workflow",
  GIT_COMMITTER_EMAIL: "pi-workflow@example.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};
let pathCounter = 0;

export class WorktreeRegistry {
  private readonly paths = new Set<string>();
  private readonly snapshots = new Set<string>();
  private readonly removals = new Map<string, Promise<WorktreeGitCommandResult>>();
  private readonly runner: WorktreeGitRunner;
  private readonly patchCapture: WorktreePatchCapture;
  private readonly timeoutMs: number;

  constructor(private readonly repoCwd: string, options: WorktreeRegistryOptions = {}) {
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
    // A rejected `git worktree add` creates nothing; tracking it would make cleanup fail on a path git never knew.
    if ("error" in added && !existsSync(added.path)) return added;
    this.register(added.path);
    if (added.snapshot === true) this.snapshots.add(added.path);
    if ("error" in added) {
      const cleanup = await this.remove(added.path);
      return { ...added, cleanup };
    }
    return added;
  }

  async capturePatch(
    path: string,
    baselineOid: string,
    signal?: AbortSignal,
  ): Promise<WorktreePatch | { readonly error: string }> {
    return await this.patchCapture({
      worktreePath: path,
      baselineOid,
      runner: this.runner,
      signal,
      timeoutMs: this.timeoutMs,
    });
  }

  async applyPatch(path: string, patch: string, signal?: AbortSignal): Promise<WorktreeGitCommandResult> {
    return this.runner.runGit({
      cwd: path, args: ["apply", "--index", "--binary", "-"],
      stdin: patch, signal, timeoutMs: this.timeoutMs,
    });
  }

  async validatePatch(path: string, candidate: WorktreePatch, signal?: AbortSignal): Promise<WorktreeGitCommandResult> {
    return await validateWorktreePatch({
      worktreePath: path,
      candidate,
      runner: this.runner,
      signal,
      timeoutMs: this.timeoutMs,
    });
  }

  async remove(path: string): Promise<WorktreeGitCommandResult> {
    const pending = this.removals.get(path);
    if (pending) return await pending;

    const removal = this.removeOnce(path).finally(() => this.removals.delete(path));
    this.removals.set(path, removal);
    return await removal;
  }

  async removeAll(): Promise<readonly WorktreeRemovalOutcome[]> {
    const outcomes = await Promise.all(
      [...this.paths].map(async (path) => ({
        path,
        ...(await this.remove(path)),
      })),
    );
    if (outcomes.some((outcome) => !outcome.ok)) throw new WorktreeCleanupError(outcomes);
    return outcomes;
  }

  private async removeOnce(path: string): Promise<WorktreeGitCommandResult> {
    const result = await removeWorktree({
      repoCwd: this.repoCwd,
      path,
      runner: this.runner,
      timeoutMs: this.timeoutMs,
      snapshot: this.snapshots.has(path),
    }).catch(toGitFailure);
    if (result.ok) {
      this.paths.delete(path);
      this.snapshots.delete(path);
    }
    return result;
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
    .catch(toGitFailure);
  if (!result.ok) return { ok: false, error: result.error };
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
  const runner = options.runner ?? spawnGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  const result = await runner
    .runGit({
      cwd: options.repoCwd,
      args: ["worktree", "add", "--detach", path, ref],
      signal: options.signal,
      timeoutMs,
    })
    .catch(toGitFailure);
  if (result.ok) {
    const patch = options.baseline?.patch;
    if (patch !== undefined && patch.trim().length > 0) {
      const prepared = await prepareWorktreeBaseline({
        path,
        patch,
        runner,
        signal: options.signal,
        timeoutMs,
      }).catch(toGitFailure);
      if (!prepared.ok) return { path, error: prepared.error };
    }
    return await finalizeWorktreeRef({ path, runner, signal: options.signal, timeoutMs });
  }

  if (!isInvalidHeadError(result.error)) return { path, error: result.error };

  return await addUnbornRepositoryWorktree({
    repoCwd: options.repoCwd,
    path,
    addError: result.error,
    runner,
    signal: options.signal,
    timeoutMs,
  });
}

async function addUnbornRepositoryWorktree(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly addError: string;
  readonly runner: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<WorktreeRef | WorktreeAddFailure> {
  const snapshotError = await createUnbornRepoSnapshot({
    repoCwd: options.repoCwd,
    path: options.path,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
    .then(() => undefined)
    .catch((error: unknown) => unknownErrorMessage(error));
  if (snapshotError !== undefined) {
    return {
      path: options.path,
      snapshot: true,
      error: `git worktree add failed (${options.addError}); unborn-repo snapshot fallback failed: ${snapshotError}`,
    };
  }
  return await finalizeWorktreeRef({
    path: options.path,
    snapshot: true,
    runner: options.runner,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
}

async function finalizeWorktreeRef(options: {
  readonly path: string;
  readonly snapshot?: boolean;
  readonly runner: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<WorktreeRef | WorktreeAddFailure> {
  const resolved = await options.runner
    .runGit({
      cwd: options.path,
      args: ["rev-parse", "--verify", "HEAD^{commit}"],
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
    .catch(toGitFailure);
  if (!resolved.ok) {
    return {
      path: options.path,
      snapshot: options.snapshot,
      error: resolved.error,
    };
  }
  const baselineOid = resolved.stdout.trim();
  if (!isGitObjectId(baselineOid)) {
    return { path: options.path, snapshot: options.snapshot, error: "isolated worktree baseline is not a commit OID" };
  }
  return { path: options.path, baselineOid, snapshot: options.snapshot };
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
      args: syntheticCommitArgs(hooksPath, "pi workflow reviewed snapshot"),
      env: SYNTHETIC_COMMIT_ENV,
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
  readonly baselineOid: string;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<WorktreePatch | { readonly error: string }> {
  if (!isGitObjectId(options.baselineOid)) return { error: "worktree patch baseline is not a commit OID" };
  const runner = options.runner ?? spawnGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  const intentToAdd = await runner
    .runGit({
      cwd: options.worktreePath,
      args: ["add", "-N", "."],
      signal: options.signal,
      timeoutMs,
    })
    .catch(toGitFailure);
  if (!intentToAdd.ok) return { error: intentToAdd.error };

  const diff = await runner
    .runGit({
      cwd: options.worktreePath,
      args: ["diff", "--binary", "--full-index", "--no-ext-diff", ...GIT_DIFF_MACHINE_FORMAT, options.baselineOid, "--"],
      signal: options.signal,
      timeoutMs,
      maxBufferBytes: WORKTREE_DIFF_MAX_BYTES,
    })
    .catch(toGitFailure);
  if (!diff.ok) return { error: diff.error };
  return { patch: diff.stdout, changed: diff.stdout.trim().length > 0 };
}

export async function validateWorktreePatch(options: {
  readonly worktreePath: string;
  readonly candidate: WorktreePatch;
  readonly runner?: WorktreeGitRunner;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<WorktreeGitCommandResult> {
  const hasPatch = options.candidate.patch.trim().length > 0;
  if (options.candidate.changed !== hasPatch) {
    return gitFailure("cached worktree patch changed flag does not match patch content");
  }
  if (!hasPatch) return { ok: true, stdout: "", stderr: "" };

  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  return await (options.runner ?? spawnGitRunner)
    .runGit({
      cwd: options.worktreePath,
      args: ["apply", "--check", "--binary", "-"],
      stdin: options.candidate.patch,
      signal: options.signal,
      timeoutMs,
    })
    .catch(toGitFailure);
}

function gitFailure(error: string): WorktreeGitCommandResult {
  return { ok: false, stdout: "", stderr: "", error };
}

function toGitFailure(error: unknown): WorktreeGitCommandResult {
  return gitFailure(unknownErrorMessage(error));
}

async function createUnbornRepoSnapshot(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}): Promise<void> {
  const { timeoutMs } = options;
  const rootProbe = await runGitCommand({
    cwd: options.repoCwd,
    args: ["rev-parse", "--show-toplevel"],
    signal: options.signal,
    timeoutMs,
  });
  if (!rootProbe.ok) throw new Error(rootProbe.error);
  const sourceRoot = parseGitTopLevel(rootProbe.stdout, options.repoCwd);
  if (!sourceRoot) throw new Error("unborn repository root probe returned an invalid path");

  const targetRoot = resolve(options.path);
  await rm(options.path, { recursive: true, force: true });
  await mkdir(options.path, { recursive: true });
  await cp(sourceRoot, options.path, {
    recursive: true,
    force: true,
    // Keep link targets as stored, like a git checkout; resolved targets would point into the source repo.
    verbatimSymlinks: true,
    filter: (source) => {
      const resolvedSource = resolve(source);
      if (resolvedSource === targetRoot || resolvedSource.startsWith(`${targetRoot}${sep}`)) return false;
      return !isExcludedDeclaredInput(portableRelativePath(sourceRoot, resolvedSource), FINGERPRINT_EXCLUDED_RELATIVE_PATHS);
    },
  });
  await requireGitCommand({ cwd: options.path, args: ["init"], signal: options.signal, timeoutMs });
  await requireGitCommand({ cwd: options.path, args: ["add", "-A"], signal: options.signal, timeoutMs });
  const hooksPath = await mkdtemp(join(tmpdir(), "pi-workflow-empty-hooks-"));
  try {
    await requireGitCommand({
      cwd: options.path,
      args: syntheticCommitArgs(hooksPath, "pi workflow baseline"),
      env: SYNTHETIC_COMMIT_ENV,
      signal: options.signal,
      timeoutMs,
    });
  } finally {
    await rm(hooksPath, { recursive: true, force: true });
  }
  await requireGitCommand({ cwd: options.path, args: ["clean", "-ffdx"], signal: options.signal, timeoutMs });
}

function syntheticCommitArgs(hooksPath: string, message: string): readonly string[] {
  return [
    "-c",
    `core.hooksPath=${hooksPath}`,
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    message,
  ];
}

async function requireGitCommand(options: WorktreeGitCommandOptions): Promise<void> {
  const result = await runGitCommand(options);
  if (!result.ok) throw new Error(result.error);
}

function isInvalidHeadError(message: string): boolean {
  return /invalid reference:\s*HEAD/i.test(message) || /ambiguous argument ['"]?HEAD/i.test(message) || /unknown revision or path.*HEAD/i.test(message);
}

export const spawnGitRunner: WorktreeGitRunner = { runGit: runGitCommand };

async function runGitCommand(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult> {
  return await runGit({ ...options, label: "git worktree command" });
}
