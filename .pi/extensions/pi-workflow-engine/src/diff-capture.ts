import type { PerfSink } from "./perf.ts";
import { runBoundedProcess, type BoundedProcessFailure } from "./process-runner.ts";
import { parseAllowedDiffCommand, reviewDiffCommand, type ReviewDiffTarget } from "./review-diff-target.ts";

export {
  formatReviewDiffTarget,
  GitReviewDiffTargetSchema,
  isReviewDiffTarget,
  parseAllowedDiffCommand,
  PullRequestReviewDiffTargetSchema,
  reviewDiffCommand,
  ReviewDiffTargetSchema,
  reviewGitDiffBaseline,
  type GitDiffBaselineTarget,
  type GitReviewDiffTarget,
  type PullRequestReviewDiffTarget,
  type ReviewDiffTarget,
} from "./review-diff-target.ts";

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

function diffCaptureEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" };
}
