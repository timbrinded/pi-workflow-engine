export class WorkflowAbortError extends Error {
  constructor(message = "Workflow aborted") {
    super(message);
    this.name = "WorkflowAbortError";
  }
}

export function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  if (typeof reason === "string" && reason.length > 0) return new WorkflowAbortError(reason);
  return new WorkflowAbortError();
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export function isFatalWorkflowError(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  if (error instanceof WorkflowAbortError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") return true;
  return false;
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
