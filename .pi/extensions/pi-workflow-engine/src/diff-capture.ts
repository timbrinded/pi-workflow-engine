import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { PerfSink } from "./perf.ts";

export interface AllowedDiffCommand {
  readonly file: "git" | "gh";
  readonly args: readonly string[];
}

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
}

const SAFE_TOKEN = /^[A-Za-z0-9_./:@~+=,\-]+$/;
const SAFE_GH_FLAG = /^--[A-Za-z0-9-]+(=[A-Za-z0-9_./:@~+=,\-]+)?$/;

export function parseAllowedDiffCommand(command: string): AllowedDiffCommand | { error: string } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: "empty or incomplete diff command" };
  if (tokens[0] === "git" && tokens[1] === "diff") {
    const args = tokens.slice(1);
    const unsafe = args.find((token) => !SAFE_TOKEN.test(token));
    if (unsafe) return { error: `unsupported git diff token: ${unsafe}` };
    return { file: "git", args };
  }
  if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "diff" && /^\d+$/.test(tokens[3] ?? "")) {
    const flags = tokens.slice(4);
    const unsafe = flags.find((token) => !SAFE_GH_FLAG.test(token));
    if (unsafe) return { error: `unsupported gh pr diff token: ${unsafe}` };
    return { file: "gh", args: ["pr", "diff", tokens[3], ...flags] };
  }
  return { error: "diff command is not in the git/gh allowlist" };
}

export async function captureDiff(command: string, options: DiffCaptureOptions): Promise<DiffCaptureResult> {
  const parsed = parseAllowedDiffCommand(command);
  if ("error" in parsed) {
    return { ok: false, stdout: "", durationMs: 0, bytes: 0, error: parsed.error };
  }

  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let error: string | undefined;
  const child = spawn(parsed.file, [...parsed.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<DiffCaptureResult>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, finishError?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      const durationMs = performance.now() - start;
      options.perf?.observe("diff.capture_ms", durationMs);
      options.perf?.observe("diff.bytes", bytes);
      resolve({ ok, stdout, durationMs, bytes, error: finishError });
    };
    const kill = (message: string) => {
      error = message;
      child.kill("SIGTERM");
    };
    const onAbort = () => kill("diff capture aborted");
    const timeout = setTimeout(() => kill(`diff capture timed out after ${options.timeoutMs}ms`), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    };

    if (options.signal?.aborted) {
      kill("diff capture aborted");
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > options.maxBufferBytes) {
        kill(`diff capture exceeded ${options.maxBufferBytes} bytes`);
        return;
      }
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
      finish(false, stderr.trim() || `diff command exited with code ${code ?? `signal ${signal ?? "unknown"}`}`);
    });
  });
}
