import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowRunRecord } from "./workflow-run-record.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface WorkflowUsageLimitSchedulerClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface ScheduledUsageLimitResume {
  readonly sessionId: string;
  readonly handle: unknown;
}

export const defaultWorkflowUsageLimitSchedulerClock: WorkflowUsageLimitSchedulerClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One in-process timer per paused run. Durable records remain the source of truth. */
export class WorkflowUsageLimitScheduler {
  private readonly scheduled = new Map<string, ScheduledUsageLimitResume>();
  private readonly inactiveSessions = new Set<string>();

  constructor(
    private readonly resume: (ctx: ExtensionContext, runId: string, attempt: number) => Promise<void>,
    private readonly clock: WorkflowUsageLimitSchedulerClock = defaultWorkflowUsageLimitSchedulerClock,
    private readonly log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  ) {}

  arm(ctx: ExtensionContext, record: WorkflowRunRecord): boolean {
    if (record.state !== "paused" || record.pause?.kind !== "provider_usage_limit") return false;
    const pause = record.pause;
    if (!pause.autoResume || pause.attempt >= pause.maxAttempts) return false;
    const sessionId = ctx.sessionManager.getSessionId();
    if (
      this.inactiveSessions.has(sessionId)
      || record.background?.origin.sessionId !== sessionId
      || this.scheduled.has(record.runId)
    ) {
      return false;
    }

    const delayMs = Math.max(0, pause.nextEligibleAt - this.clock.now());
    const handle = this.clock.setTimeout(() => {
      this.scheduled.delete(record.runId);
      void this.resume(ctx, record.runId, pause.attempt).catch((error: unknown) => {
        this.log(`[workflow:${record.runId}] automatic provider-limit resume failed: ${unknownErrorMessage(error)}`);
      });
    }, delayMs);
    this.scheduled.set(record.runId, { sessionId, handle });
    return true;
  }

  cancel(runId: string): boolean {
    const scheduled = this.scheduled.get(runId);
    if (!scheduled) return false;
    this.clock.clearTimeout(scheduled.handle);
    this.scheduled.delete(runId);
    return true;
  }

  cancelSession(ctx: Pick<ExtensionContext, "sessionManager">): void {
    const sessionId = ctx.sessionManager.getSessionId();
    this.inactiveSessions.add(sessionId);
    for (const [runId, scheduled] of this.scheduled) {
      if (scheduled.sessionId === sessionId) this.cancel(runId);
    }
  }

  activateSession(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.inactiveSessions.delete(ctx.sessionManager.getSessionId());
  }

  has(runId: string): boolean {
    return this.scheduled.has(runId);
  }
}
