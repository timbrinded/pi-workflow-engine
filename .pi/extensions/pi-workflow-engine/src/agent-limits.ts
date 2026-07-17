import { throwIfAborted } from "./cancellation.ts";

export class WorkflowAgentLimitError extends Error {
  override readonly name = "WorkflowAgentLimitError";
  readonly code = "WORKFLOW_AGENT_LIMIT_EXCEEDED";

  constructor(readonly maxAgents: number) {
    super(`Workflow live-agent limit of ${maxAgents} has been reached; no new model request was started.`);
  }
}

export class WorkflowAgentTimeoutError extends Error {
  override readonly name = "WorkflowAgentTimeoutError";
  readonly code = "WORKFLOW_AGENT_TIMEOUT";

  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`Workflow agent "${label}" exceeded its ${timeoutMs}ms duration limit.`);
  }
}

/** Shared run-level admission counter. Cache hits do not call admit(). */
export class WorkflowAgentLimiter {
  private admitted = 0;

  constructor(readonly maxAgents: number) {}

  admit(signal: AbortSignal | undefined): void {
    throwIfAborted(signal);
    if (this.admitted >= this.maxAgents) throw new WorkflowAgentLimitError(this.maxAgents);
    this.admitted++;
  }
}
