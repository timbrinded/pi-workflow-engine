import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface BoundedProcessOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
  readonly killGraceMs?: number;
  readonly abortError: string;
  readonly timeoutError: string;
  readonly maxBufferError?: string;
  readonly exitError: (stderr: string, code: number | null, signal: NodeJS.Signals | null) => string;
}

export interface BoundedProcessResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly bytes: number;
  readonly error?: string;
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let error: string | undefined;
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return await new Promise<BoundedProcessResult>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const killGraceMs = Math.max(1, options.killGraceMs ?? 100);
    const finish = (ok: boolean, finishError?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok, stdout, stderr, durationMs: performance.now() - start, bytes, error: finishError });
    };
    const kill = (message: string) => {
      error = error ?? message;
      child.kill("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        child.kill("SIGKILL");
        finish(false, error);
      }, killGraceMs);
    };
    const onAbort = () => kill(options.abortError);
    const timeout = setTimeout(() => kill(options.timeoutError), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    if (options.signal?.aborted) {
      kill(options.abortError);
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (options.maxBufferBytes !== undefined && bytes > options.maxBufferBytes) {
        kill(options.maxBufferError ?? `process output exceeded ${options.maxBufferBytes} bytes`);
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
      finish(false, options.exitError(stderr, code, signal));
    });
  });
}
