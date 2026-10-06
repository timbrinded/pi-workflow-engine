import {
  runBoundedProcess,
  scrubbedGitEnv,
  type BoundedProcessResult,
} from "./process-runner.ts";
import { reviewDiffCommand, type ReviewDiffTarget } from "./review-diff-target.ts";

export interface DiffCaptureOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly killGraceMs?: number;
}

export async function captureDiffTarget(target: ReviewDiffTarget, options: DiffCaptureOptions): Promise<BoundedProcessResult> {
  const command = reviewDiffCommand(target);
  return await runBoundedProcess({
    file: command.file,
    args: command.args,
    cwd: options.cwd,
    env: scrubbedGitEnv(options.env),
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxBufferBytes: options.maxBufferBytes,
    killGraceMs: options.killGraceMs,
    abortError: "diff capture aborted",
    timeoutError: `diff capture timed out after ${options.timeoutMs}ms`,
    maxBufferError: `diff capture exceeded ${options.maxBufferBytes} bytes`,
    exitError: (stderr, code, signal) => stderr.trim() || `diff command exited with code ${code ?? `signal ${signal ?? "unknown"}`}`,
  });
}
