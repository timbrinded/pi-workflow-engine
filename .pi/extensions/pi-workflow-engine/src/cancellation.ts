export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}

/** Abort reason used when a durable run can be resumed after its host session shuts down. */
export class WorkflowPauseError extends WorkflowAbortError {
  constructor(message = "Workflow paused because its host session shut down") {
    super(message);
    this.name = "WorkflowPauseError";
  }
}

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (safeInstanceOf(reason, Error)) return reason;
  if (typeof reason === "string" && reason.length > 0) return new WorkflowAbortError(reason);
  return new WorkflowAbortError();
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function isFatalWorkflowError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (safeInstanceOf(error, WorkflowAbortError)) return true;
  if (typeof DOMException !== "undefined" && safeInstanceOf(error, DOMException)) {
    try {
      return error.name === "AbortError";
    } catch {
      return false;
    }
  }
  return false;
}

export function isWorkflowPauseError(error: unknown): error is WorkflowPauseError {
  return safeInstanceOf(error, WorkflowPauseError);
}

export function linkAbortSignal(parent: AbortSignal | undefined, controller: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    controller.abort(abortReason(parent));
    return () => {};
  }
  const onAbort = () => controller.abort(abortReason(parent));
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
}

export async function raceWithAbort<T>(operation: () => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await operation();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void operation().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function safeInstanceOf<T>(value: unknown, constructor: abstract new (...args: never[]) => T): value is T {
  try {
    return value instanceof constructor;
  } catch {
    return false;
  }
}
