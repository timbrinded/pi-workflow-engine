import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { runBoundedProcess } from "./process-runner.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface WorktreeGitCommandOptions {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
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

export interface GitWorktreeProbe {
  readonly ok: boolean;
  readonly inside: boolean;
  readonly error?: string;
}

export interface WorktreeRemovalOutcome extends WorktreeGitCommandResult {
  readonly path: string;
}

export class WorktreeCleanupError extends AggregateError {
  readonly outcomes: readonly WorktreeRemovalOutcome[];

  constructor(outcomes: readonly WorktreeRemovalOutcome[]) {
    const failures = outcomes.filter((outcome) => !outcome.ok);
    const details = failures.map((failure) => `${failure.path} (${worktreeRemovalError(failure)})`);
    super(
      failures.map((failure) => new Error(`Failed to remove isolated worktree ${failure.path}: ${worktreeRemovalError(failure)}`)),
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
  readonly repoCwd: string;
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
    }).catch((error: unknown) => ({
      ok: false,
      stdout: "",
      stderr: "",
      error: unknownErrorMessage(error),
    }));
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
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
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
  const runner = options.runner ?? spawnGitRunner;
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  const result = await runner
    .runGit({
      cwd: options.repoCwd,
      args: ["worktree", "add", "--detach", path, ref],
      signal: options.signal,
      timeoutMs,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
  if (result.ok) {
    const patch = options.baseline?.patch;
    if (patch !== undefined && patch.trim().length > 0) {
      const prepared = await prepareWorktreeBaseline({
        path,
        patch,
        runner,
        signal: options.signal,
        timeoutMs,
      }).catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
      if (!prepared.ok) return { path, error: prepared.error ?? (prepared.stderr.trim() || "failed to prepare worktree baseline") };
    }
    return await finalizeWorktreeRef({ path, runner, signal: options.signal, timeoutMs });
  }

  const message = result.error ?? (result.stderr.trim() || "git worktree add failed");
  if (!isInvalidHeadError(message)) return { path, error: message };

  const snapshotError = await createUnbornRepoSnapshot({ repoCwd: options.repoCwd, path, timeoutMs: options.timeoutMs, signal: options.signal })
    .then(() => undefined)
    .catch((error: unknown) => unknownErrorMessage(error));
  if (snapshotError !== undefined) return { path, snapshot: true, error: `git worktree add failed (${message}); unborn-repo snapshot fallback failed: ${snapshotError}` };
  return await finalizeWorktreeRef({ path, snapshot: true, runner, signal: options.signal, timeoutMs });
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
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
  if (!resolved.ok) {
    return {
      path: options.path,
      snapshot: options.snapshot,
      error: resolved.error ?? (resolved.stderr.trim() || "failed to resolve isolated worktree baseline"),
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
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
  if (!intentToAdd.ok) return { error: intentToAdd.error ?? (intentToAdd.stderr.trim() || "git add -N failed before patch capture") };

  const diff = await runner
    .runGit({
      cwd: options.worktreePath,
      args: ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-color", options.baselineOid, "--"],
      signal: options.signal,
      timeoutMs,
      maxBufferBytes: WORKTREE_DIFF_MAX_BYTES,
    })
    .catch((error: unknown) => ({ ok: false, stdout: "", stderr: "", error: unknownErrorMessage(error) }));
  if (!diff.ok) return { error: diff.error ?? (diff.stderr.trim() || "worktree diff capture failed") };
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
    return invalidPatchResult("cached worktree patch changed flag does not match patch content");
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
    .catch((error: unknown) => invalidPatchResult(unknownErrorMessage(error)));
}

function invalidPatchResult(error: string): WorktreeGitCommandResult {
  return { ok: false, stdout: "", stderr: "", error };
}

async function createUnbornRepoSnapshot(options: {
  readonly repoCwd: string;
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKTREE_TIMEOUT_MS;
  const rootProbe = await runGitCommand({
    cwd: options.repoCwd,
    args: ["rev-parse", "--show-toplevel"],
    signal: options.signal,
    timeoutMs,
  });
  if (!rootProbe.ok) {
    throw new Error(rootProbe.error ?? (rootProbe.stderr.trim() || "failed to resolve unborn repository root"));
  }
  const sourceRoot = parseGitTopLevel(rootProbe.stdout, options.repoCwd);
  if (!sourceRoot) throw new Error("unborn repository root probe returned an invalid path");

  const targetRoot = resolve(options.path);
  await rm(options.path, { recursive: true, force: true });
  await mkdir(options.path, { recursive: true });
  await cp(sourceRoot, options.path, {
    recursive: true,
    force: true,
    filter: (source) => {
      const resolvedSource = resolve(source);
      if (resolvedSource === targetRoot || resolvedSource.startsWith(`${targetRoot}${sep}`)) return false;
      return !isExcludedSnapshotPath(sourceRoot, resolvedSource);
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
  if (!result.ok) throw new Error(result.error ?? (result.stderr.trim() || "git command failed"));
}

function parseGitTopLevel(output: string, cwd: string): string | undefined {
  const withoutLf = output.endsWith("\n") ? output.slice(0, -1) : output;
  const value = withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
  if (value.length === 0 || value.includes("\n") || value.includes("\0")) return undefined;
  const root = resolve(cwd, value);
  const cwdFromRoot = relative(root, resolve(cwd));
  return isAbsolute(cwdFromRoot) || cwdFromRoot === ".." || cwdFromRoot.startsWith(`..${sep}`) ? undefined : root;
}

function isExcludedSnapshotPath(sourceRoot: string, source: string): boolean {
  const path = relative(sourceRoot, source);
  if (path.length === 0) return false;
  const segments = path.split(sep);
  if (segments.includes(".git")) return true;
  return segments.some((segment, index) => segment === ".pi" && segments[index + 1] === ".workflow-runs");
}

function isInvalidHeadError(message: string): boolean {
  return /invalid reference:\s*HEAD/i.test(message) || /ambiguous argument ['"]?HEAD/i.test(message) || /unknown revision or path.*HEAD/i.test(message);
}

function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

export const spawnGitRunner: WorktreeGitRunner = {
  async runGit(options) {
    return await runGitCommand(options);
  },
};

async function runGitCommand(options: WorktreeGitCommandOptions): Promise<WorktreeGitCommandResult> {
  const env = { ...process.env, ...options.env };
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

function worktreeRemovalError(outcome: WorktreeRemovalOutcome): string {
  return outcome.error ?? (outcome.stderr.trim() || "unknown error");
}
