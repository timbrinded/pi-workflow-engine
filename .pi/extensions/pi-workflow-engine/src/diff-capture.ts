import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { PerfSink } from "./perf.ts";
import { runBoundedProcess, type BoundedProcessFailure } from "./process-runner.ts";

export type GitDiffBaselineTarget =
  | { readonly kind: "working-tree" }
  | { readonly kind: "index" }
  | { readonly kind: "range"; readonly ref: string };

export const GitReviewDiffTargetSchema = Type.Object({
  kind: Type.Literal("git"),
  args: Type.Array(Type.String()),
});

export const PullRequestReviewDiffTargetSchema = Type.Object({
  kind: Type.Literal("pull-request"),
  number: Type.Integer({ minimum: 1 }),
});

export const ReviewDiffTargetSchema = Type.Union([GitReviewDiffTargetSchema, PullRequestReviewDiffTargetSchema]);

export type GitReviewDiffTarget = Static<typeof GitReviewDiffTargetSchema>;
export type PullRequestReviewDiffTarget = Static<typeof PullRequestReviewDiffTargetSchema>;

/** Serializable semantic identity of the diff being reviewed. */
export type ReviewDiffTarget = Static<typeof ReviewDiffTargetSchema>;

interface DiffCaptureResultBase {
  readonly stdout: string;
  readonly durationMs: number;
  readonly bytes: number;
}

export type DiffCaptureResult =
  | (DiffCaptureResultBase & { readonly ok: true; readonly error?: undefined; readonly failure?: undefined })
  | (DiffCaptureResultBase & { readonly ok: false; readonly error: string; readonly failure: DiffCaptureFailure });

export type DiffCaptureFailure = BoundedProcessFailure | { readonly kind: "invalid-target"; readonly message: string };

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
const SAFE_GH_DIFF_FLAGS = new Set(["--color=never"]);
const SAFE_GIT_DIFF_FLAGS = new Set(["--binary", "--cached", "--staged", "--no-color", "--color=never", "--no-ext-diff"]);

export function parseAllowedDiffCommand(command: string): ReviewDiffTarget | { error: string } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: "empty or incomplete diff command" };
  if (tokens[0] === "git" && tokens[1] === "diff") {
    const parsed = parseGitDiff(tokens);
    return "error" in parsed ? parsed : parsed.target;
  }
  if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "diff" && /^\d+$/.test(tokens[3] ?? "")) {
    const number = Number(tokens[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return { error: "pull-request number must be a positive safe integer" };
    const flags = tokens.slice(4);
    if (flags.includes("--patch")) return { error: "gh pr diff --patch is not supported because reviews require the cumulative pull-request diff" };
    const unsupported = flags.find((token) => !SAFE_GH_DIFF_FLAGS.has(token));
    if (unsupported) return { error: `unsupported gh pr diff option: ${unsupported}` };
    return { kind: "pull-request", number };
  }
  return { error: "diff command is not in the git/gh allowlist" };
}

function parseGitDiff(
  tokens: readonly string[],
): { readonly target: GitReviewDiffTarget; readonly baseline: GitDiffBaselineTarget } | { readonly error: string } {
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
  return "error" in baseline ? baseline : { target: { kind: "git", args: safeArgs }, baseline };
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
    return {
      ok: false,
      stdout: "",
      durationMs: 0,
      bytes: 0,
      error: parsed.error,
      failure: { kind: "invalid-target", message: parsed.error },
    };
  }

  return await captureDiffTarget(parsed, options);
}

export async function captureDiffTarget(target: ReviewDiffTarget, options: DiffCaptureOptions): Promise<DiffCaptureResult> {
  const command = reviewDiffCommand(target);
  const result = await runBoundedProcess({
    file: command.file,
    args: command.args,
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

export function reviewDiffCommand(target: ReviewDiffTarget): { readonly file: "git" | "gh"; readonly args: readonly string[] } {
  return target.kind === "pull-request"
    ? { file: "gh", args: ["pr", "diff", String(target.number), "--color=never"] }
    : { file: "git", args: target.args };
}

/** Canonical display form. Never execute this string directly; use reviewDiffCommand(). */
export function formatReviewDiffTarget(target: ReviewDiffTarget): string {
  const command = reviewDiffCommand(target);
  return [command.file, ...command.args].join(" ");
}

/** Derive reconstruction semantics from the canonical git command instead of persisting duplicate state. */
export function reviewGitDiffBaseline(target: GitReviewDiffTarget): GitDiffBaselineTarget {
  const parsed = parseGitDiff(["git", ...target.args]);
  if ("error" in parsed) throw new Error(`Invalid persisted git review target: ${parsed.error}`);
  return parsed.baseline;
}

/** Validate persisted targets by round-tripping through the single command allowlist parser. */
export function isReviewDiffTarget(value: unknown): value is ReviewDiffTarget {
  if (!Value.Check(ReviewDiffTargetSchema, value)) return false;
  const parsed = parseAllowedDiffCommand(formatReviewDiffTarget(value));
  return !("error" in parsed) && sameReviewDiffTarget(parsed, value);
}

function sameReviewDiffTarget(left: ReviewDiffTarget, right: ReviewDiffTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pull-request") return right.kind === "pull-request" && left.number === right.number;
  if (right.kind !== "git" || left.args.length !== right.args.length) return false;
  return left.args.every((arg, index) => arg === right.args[index]);
}

function diffCaptureEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" };
}
