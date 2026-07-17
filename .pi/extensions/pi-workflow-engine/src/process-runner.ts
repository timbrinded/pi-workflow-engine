import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface BoundedProcessOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxBufferBytes?: number;
  readonly killGraceMs?: number;
  readonly abortError: string;
  readonly timeoutError: string;
  readonly maxBufferError?: string;
  readonly exitError: (stderr: string, code: number | null, signal: NodeJS.Signals | null) => string;
}

interface BoundedProcessResultBase {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly bytes: number;
}

export type BoundedProcessFailure =
  | { readonly kind: "spawn" | "abort" | "timeout" | "max-buffer"; readonly message: string }
  | {
      readonly kind: "exit";
      readonly message: string;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

export type BoundedProcessResult =
  | (BoundedProcessResultBase & { readonly ok: true; readonly error?: undefined; readonly failure?: undefined })
  | (BoundedProcessResultBase & {
      readonly ok: false;
      /** Backward-compatible display message. Branch on `failure.kind` for control flow. */
      readonly error: string;
      readonly failure: BoundedProcessFailure;
    });

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let pendingFailure: BoundedProcessFailure | undefined;
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== "win32",
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  return await new Promise<BoundedProcessResult>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let hardSettleTimer: ReturnType<typeof setTimeout> | undefined;
    const killGraceMs = Math.max(1, options.killGraceMs ?? 100);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (failure?: BoundedProcessFailure) => {
      if (settled) return;
      settled = true;
      cleanup();
      const base = { stdout, stderr, durationMs: performance.now() - start, bytes };
      resolve(failure ? { ...base, ok: false, error: failure.message, failure } : { ...base, ok: true });
    };
    const signalProcess = (signal: NodeJS.Signals) => {
      if (process.platform === "win32" && child.pid !== undefined) {
        try {
          const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
            detached: false,
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => {
            try {
              child.kill(signal);
            } catch {
              // The hard-settlement timer remains authoritative.
            }
          });
          killer.unref();
          return;
        } catch {
          // Fall through to direct-child termination when taskkill cannot start.
        }
      }
      let groupSignalled = false;
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          groupSignalled = true;
        } catch {
          // The process may have exited before its descendants released stdio.
          // Fall back to the direct child below.
        }
      }
      if (!groupSignalled) {
        try {
          child.kill(signal);
        } catch {
          // The hard-settlement timer remains authoritative when signalling fails.
        }
      }
    };
    const destroyStdio = () => {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const terminate = (failure: BoundedProcessFailure) => {
      pendingFailure ??= failure;
      if (forceKillTimer) return;
      signalProcess("SIGTERM");
      forceKillTimer ??= setTimeout(() => {
        signalProcess("SIGKILL");
        destroyStdio();
        if (!settled) hardSettleTimer = setTimeout(() => finish(pendingFailure), killGraceMs);
      }, killGraceMs);
    };
    const onAbort = () => terminate({ kind: "abort", message: options.abortError });
    const timeout = setTimeout(() => terminate({ kind: "timeout", message: options.timeoutError }), options.timeoutMs);

    const captureChunk = (chunk: Buffer, append: (text: string) => void) => {
      if (pendingFailure) return;
      bytes += chunk.length;
      if (options.maxBufferBytes !== undefined && bytes > options.maxBufferBytes) {
        terminate({
          kind: "max-buffer",
          message: options.maxBufferError ?? `process output exceeded ${options.maxBufferBytes} bytes`,
        });
        return;
      }
      append(chunk.toString("utf8"));
    };
    child.stdout?.on("data", (chunk: Buffer) => captureChunk(chunk, (text) => (stdout += text)));
    child.stderr?.on("data", (chunk: Buffer) => captureChunk(chunk, (text) => (stderr += text)));
    child.on("error", (spawnError) => {
      if (!pendingFailure) finish({ kind: "spawn", message: spawnError.message });
    });
    child.on("close", (code, signal) => {
      if (pendingFailure) {
        finish(pendingFailure);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const message = options.exitError(stderr, code, signal);
      finish({ kind: "exit", message, code, signal });
    });
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    if (options.stdin !== undefined) {
      // The child may reject input and exit before consuming it. Its process exit
      // remains the authoritative result; avoid surfacing a secondary EPIPE.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin);
    }
  });
}
