import type { PerfSink } from "./perf.ts";
import { runBoundedProcess } from "./process-runner.ts";

export type GitDiffBaselineTarget =
  | { readonly kind: "working-tree" }
  | { readonly kind: "index" }
  | { readonly kind: "range"; readonly ref: string };

export interface AllowedGitDiffTarget {
  readonly kind: "git";
  readonly file: "git";
  readonly args: readonly string[];
  /** The semantic post-diff target used when reconstructing a review snapshot. */
  readonly baseline: GitDiffBaselineTarget;
}

export interface AllowedPullRequestDiffTarget {
  readonly kind: "pull-request";
  readonly file: "gh";
  readonly args: readonly string[];
  readonly pullRequestNumber: string;
}

export type AllowedDiffTarget = AllowedGitDiffTarget | AllowedPullRequestDiffTarget;

export interface DiffCaptureResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly durationMs: number;
  readonly bytes: number;
  readonly error?: string;
}

export interface DiffCaptureOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly perf?: PerfSink;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
}

const SAFE_REF_OR_PATH = /^[A-Za-z0-9_./:@~+=,\-]+$/;
const SAFE_GH_DIFF_FLAGS = new Set(["--patch", "--color=never"]);
const SAFE_GIT_DIFF_FLAGS = new Set(["--binary", "--cached", "--staged", "--no-color", "--color=never", "--no-ext-diff"]);

export function parseAllowedDiffCommand(command: string): AllowedDiffTarget | { error: string } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: "empty or incomplete diff command" };
  if (tokens[0] === "git" && tokens[1] === "diff") return parseGitDiff(tokens);
  if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "diff" && /^\d+$/.test(tokens[3] ?? "")) {
    const flags = tokens.slice(4);
    const unsupported = flags.find((token) => !SAFE_GH_DIFF_FLAGS.has(token));
    if (unsupported) return { error: `unsupported gh pr diff option: ${unsupported}` };
    return {
      kind: "pull-request",
      file: "gh",
      args: ["pr", "diff", tokens[3], "--patch", "--color=never"],
      pullRequestNumber: tokens[3]!,
    };
  }
  return { error: "diff command is not in the git/gh allowlist" };
}

function parseGitDiff(tokens: readonly string[]): AllowedGitDiffTarget | { error: string } {
  const args = tokens.slice(2);
  const safeArgs = ["diff", "--no-ext-diff"];
  const operands: string[] = [];
  let staged = false;
  let pathMode = false;

  for (const token of args) {
    if (!SAFE_REF_OR_PATH.test(token)) return { error: `unsupported git diff token: ${token}` };
    if (token === "--") {
      pathMode = true;
      safeArgs.push(token);
      continue;
    }
    if (!pathMode && token.startsWith("-")) {
      if (!isAllowedGitDiffFlag(token)) return { error: `unsupported git diff option: ${token}` };
      staged ||= token === "--cached" || token === "--staged";
      if (token !== "--no-ext-diff") safeArgs.push(token);
      continue;
    }
    if (!pathMode) operands.push(token);
    safeArgs.push(token);
  }

  const baseline = classifyGitDiffBaseline(staged, operands);
  return "error" in baseline ? baseline : { kind: "git", file: "git", args: safeArgs, baseline };
}

function classifyGitDiffBaseline(staged: boolean, operands: readonly string[]): GitDiffBaselineTarget | { readonly error: string } {
  if (operands.length > 1) {
    return { error: "ambiguous git diff operands; use A..B or A...B for revisions, or -- before multiple paths" };
  }
  if (staged) return { kind: "index" };

  const range = operands.find((operand) => operand.includes(".."));
  if (range) {
    const separator = range.includes("...") ? "..." : "..";
    return { kind: "range", ref: range.slice(range.indexOf(separator) + separator.length) || "HEAD" };
  }

  return { kind: "working-tree" };
}

function isAllowedGitDiffFlag(token: string): boolean {
  return SAFE_GIT_DIFF_FLAGS.has(token) || /^-U\d+$/.test(token) || /^--unified=\d+$/.test(token) || /^--inter-hunk-context=\d+$/.test(token);
}

export async function captureDiff(command: string, options: DiffCaptureOptions): Promise<DiffCaptureResult> {
  const parsed = parseAllowedDiffCommand(command);
  if ("error" in parsed) {
    return { ok: false, stdout: "", durationMs: 0, bytes: 0, error: parsed.error };
  }

  return await captureDiffTarget(parsed, options);
}

export async function captureDiffTarget(target: AllowedDiffTarget, options: DiffCaptureOptions): Promise<DiffCaptureResult> {
  const result = await runBoundedProcess({
    file: target.file,
    args: target.args,
    cwd: options.cwd,
    env: diffCaptureEnv(options.env),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    killGraceMs: options.killGraceMs,
    abortError: "diff capture aborted",
    timeoutError: `diff capture timed out after ${options.timeoutMs}ms`,
    maxBufferError: `diff capture exceeded ${options.maxBufferBytes} bytes`,
    exitError: (stderr, code, signal) => stderr.trim() || `diff command exited with code ${code ?? `signal ${signal ?? "unknown"}`}`,
  });
  options.perf?.observe("diff.capture_ms", result.durationMs);
  options.perf?.observe("diff.bytes", result.bytes);
  return result;
}

function diffCaptureEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" };
}
