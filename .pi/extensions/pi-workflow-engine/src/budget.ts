import type { WorkflowUsageSink } from "./usage.ts";

/**
 * Thrown by `agent()` when a run has consumed its token budget. Carries the
 * configured ceiling and the output tokens spent so callers can report both.
 */
export class WorkflowBudgetExceededError extends Error {
  constructor(
    readonly total: number,
    readonly spent: number,
  ) {
    super(`Workflow token budget exhausted: spent ${spent} output tokens of ${total}.`);
    this.name = "WorkflowBudgetExceededError";
  }
}

/**
 * The budget handle exposed on `WorkflowApi`. Mirrors the built-in Workflow tool:
 * `total` is the output-token ceiling (or `null` when unset), `spent()` is the
 * output tokens consumed by completed agents this run, and `remaining()` is the
 * headroom left (`Infinity` when there is no ceiling).
 *
 * `spent()`/`remaining()` are LIVE — they re-read usage on every call so that
 * `while (budget.total && budget.remaining() > N) { await agent(...) }` loops and
 * `Math.floor(budget.total / N)` fleet-scaling see up-to-date numbers.
 */
export interface WorkflowBudget {
  readonly total: number | null;
  /** Output tokens consumed by completed agents this run (sub-workflows included). */
  spent(): number;
  /** `total - spent()` clamped at 0, or `Infinity` when `total` is null. */
  remaining(): number;
}

/** Refuse a new model turn after the run has consumed its output-token budget. */
export function assertWorkflowBudgetAvailable(budget: WorkflowBudget): void {
  if (budget.total !== null && budget.remaining() <= 0) {
    throw new WorkflowBudgetExceededError(budget.total, budget.spent());
  }
}

/**
 * Build a budget backed by the run's usage sink. `spent()` reads
 * `usage.snapshot().totals.output` — the same output-token sum surfaced in the
 * usage line — so no separate token accounting is needed.
 */
export function createBudget(total: number | null, usage: WorkflowUsageSink): WorkflowBudget {
  return {
    total,
    spent: () => usage.snapshot().totals.output,
    remaining: () => (total === null ? Infinity : Math.max(0, total - usage.snapshot().totals.output)),
  };
}
