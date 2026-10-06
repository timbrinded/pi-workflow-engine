import { resolve } from "node:path";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.ts";
import { isPathWithin } from "./tree-fingerprint.ts";

export interface GitCommandOptions {
  /** The GitHub CLI shares the runner so pull-request commands get the same bounds. Defaults to `git`. */
  readonly file?: "git" | "gh";
  readonly cwd: string;
  readonly args: readonly string[];
  /** Names the command in its abort, timeout, output-limit, and exit messages. */
  readonly label: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
  readonly stdin?: string;
  /** Overrides merged over `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Pins the git diff output that the engine parses or applies, so user config such as
 * diff.noprefix, diff.mnemonicPrefix, diff.srcPrefix or color.ui cannot change it.
 */
export const GIT_DIFF_MACHINE_FORMAT = ["--no-color", "--src-prefix=a/", "--dst-prefix=b/"] as const;

export async function runGit(options: GitCommandOptions): Promise<BoundedProcessResult> {
  const { label, timeoutMs, maxBufferBytes } = options;
  const env = { ...process.env, ...options.env };
  // Drop env-level diff overrides so git emits plain patches. Setting them to an empty string
  // instead makes a plain `git diff` try to run an empty external diff command.
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return await runBoundedProcess({
    file: options.file ?? "git",
    args: options.args,
    cwd: options.cwd,
    env,
    stdin: options.stdin,
    signal: options.signal,
    timeoutMs,
    maxBufferBytes,
    abortError: `${label} aborted`,
    timeoutError: `${label} timed out after ${timeoutMs}ms`,
    maxBufferError: maxBufferBytes === undefined ? undefined : `${label} exceeded ${maxBufferBytes} bytes`,
    exitError: (stderr, code, signal) => stderr.trim() || `${label} exited with code ${code ?? `signal ${signal ?? "unknown"}`}`,
  });
}

/** A full SHA-1 or SHA-256 Git object ID. */
export function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

/** Resolve `git rev-parse --show-toplevel` output to a root that contains `cwd`. */
export function parseGitTopLevel(output: string, cwd: string): string | undefined {
  const withoutLf = output.endsWith("\n") ? output.slice(0, -1) : output;
  const value = withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
  if (value.length === 0 || value.includes("\n") || value.includes("\0")) return undefined;
  const root = resolve(cwd, value);
  return isPathWithin(root, cwd) ? root : undefined;
}
