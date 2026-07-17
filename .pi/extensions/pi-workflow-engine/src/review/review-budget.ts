import type { WorkflowUsageSnapshot } from "../usage.ts";

export type ReviewFixLease =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: "busy" | "exhausted" };

/** Session-local budget ledger that serializes fix previews and records every finalized run. */
export class ReviewFixBudgetLedger {
  private inFlight = false;
  private remainingBudget: number | undefined;

  constructor(budget: number | null | undefined, initialUsage: WorkflowUsageSnapshot | undefined) {
    this.remainingBudget = remainingWorkflowBudget(budget, initialUsage);
  }

  get remaining(): number | undefined {
    return this.remainingBudget;
  }

  acquire(): ReviewFixLease {
    if (this.remainingBudget === 0) return { ok: false, reason: "exhausted" };
    if (this.inFlight) return { ok: false, reason: "busy" };
    this.inFlight = true;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight = false;
      },
    };
  }

  record(usage: WorkflowUsageSnapshot): void {
    this.remainingBudget = remainingWorkflowBudget(this.remainingBudget, usage);
  }
}

export function remainingWorkflowBudget(
  budget: number | null | undefined,
  usage: WorkflowUsageSnapshot | undefined,
): number | undefined {
  return budget == null ? undefined : Math.max(0, budget - (usage?.totals.output ?? 0));
}
