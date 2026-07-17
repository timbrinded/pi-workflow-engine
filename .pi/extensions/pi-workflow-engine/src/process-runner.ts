import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { unknownErrorMessage } from "./unknown-error.ts";

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

export interface UnconfirmedProcessTermination {
  readonly status: "unconfirmed";
  readonly reason: string;
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
      /** Present only when the runner's final bound elapsed without observing child closure. */
      readonly termination?: UnconfirmedProcessTermination;
    });

export type WindowsTaskkillResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface ProcessRunnerDependencies {
  readonly platform: NodeJS.Platform;
  readonly runWindowsTaskkill: (pid: number, complete: (result: WindowsTaskkillResult) => void) => void;
  readonly killChild: (child: ChildProcess, signal: NodeJS.Signals) => boolean;
}

const NODE_PROCESS_RUNNER_DEPENDENCIES: ProcessRunnerDependencies = {
  platform: process.platform,
  runWindowsTaskkill(pid, complete) {
    let completed = false;
    const finish = (result: WindowsTaskkillResult) => {
      if (completed) return;
      completed = true;
      complete(result);
    };
    try {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", (error) => finish({ ok: false, reason: `taskkill failed to start: ${unknownErrorMessage(error)}` }));
      killer.once("close", (code, signal) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        finish({
          ok: false,
          reason: `taskkill exited with ${code === null ? `signal ${signal ?? "unknown"}` : `code ${code}`}`,
        });
      });
      killer.unref();
    } catch (error) {
      finish({ ok: false, reason: `taskkill could not be started: ${unknownErrorMessage(error)}` });
    }
  },
  killChild: (child, signal) => child.kill(signal),
};

export async function runBoundedProcess(
  options: BoundedProcessOptions,
  dependencies: ProcessRunnerDependencies = NODE_PROCESS_RUNNER_DEPENDENCIES,
): Promise<BoundedProcessResult> {
  const start = performance.now();
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let pendingFailure: BoundedProcessFailure | undefined;
  const child = spawn(options.file, [...options.args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: dependencies.platform !== "win32",
    stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });

  return await new Promise<BoundedProcessResult>((resolve) => {
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    let hardSettleTimer: ReturnType<typeof setTimeout> | undefined;
    let directChildKillAttempted = false;
    let windowsTerminationReason = "process close was not observed after taskkill and direct-child fallback";
    const killGraceMs = Math.max(1, options.killGraceMs ?? 100);
    const cleanup = () => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (hardSettleTimer) clearTimeout(hardSettleTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (failure?: BoundedProcessFailure, termination?: UnconfirmedProcessTermination) => {
      if (settled) return;
      settled = true;
      cleanup();
      const base = { stdout, stderr, durationMs: performance.now() - start, bytes };
      if (!failure) {
        resolve({ ...base, ok: true });
        return;
      }
      resolve({ ...base, ok: false, error: failure.message, failure, ...(termination ? { termination } : {}) });
    };
    const killDirectChild = (signal: NodeJS.Signals, reason: string) => {
      if (directChildKillAttempted) return;
      directChildKillAttempted = true;
      windowsTerminationReason = reason;
      try {
        if (!dependencies.killChild(child, signal)) {
          windowsTerminationReason = `${reason}; direct-child termination was not accepted`;
        }
      } catch (error) {
        windowsTerminationReason = `${reason}; direct-child termination failed: ${unknownErrorMessage(error)}`;
      }
    };
    const signalPosixProcess = (signal: NodeJS.Signals) => {
      let groupSignalled = false;
      if (child.pid !== undefined) {
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
          dependencies.killChild(child, signal);
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
      if (dependencies.platform === "win32") {
        if (child.pid === undefined) {
          killDirectChild("SIGKILL", "taskkill was unavailable because the child process had no pid");
        } else {
          try {
            dependencies.runWindowsTaskkill(child.pid, (result) => {
              if (settled || result.ok) return;
              killDirectChild("SIGKILL", result.reason);
            });
          } catch (error) {
            killDirectChild("SIGKILL", `taskkill invocation failed: ${unknownErrorMessage(error)}`);
          }
        }
      } else {
        signalPosixProcess("SIGTERM");
      }
      forceKillTimer = setTimeout(() => {
        if (dependencies.platform === "win32") {
          if (directChildKillAttempted) {
            windowsTerminationReason = `${windowsTerminationReason}; child did not close within the termination grace period`;
          } else {
            killDirectChild("SIGKILL", "taskkill did not close the child within the termination grace period");
          }
        } else {
          signalPosixProcess("SIGKILL");
        }
        destroyStdio();
        if (!settled) {
          hardSettleTimer = setTimeout(() => {
            if (!pendingFailure) return;
            finish(
              pendingFailure,
              { status: "unconfirmed", reason: dependencies.platform === "win32"
                ? windowsTerminationReason
                : "process close was not observed after forced process-group termination" },
            );
          }, killGraceMs);
        }
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
