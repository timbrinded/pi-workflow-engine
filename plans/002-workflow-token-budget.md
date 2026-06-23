# Plan 002: Token/cost budget for workflow runs

> **Executor instructions**: Follow this plan step by step. Run the verification commands and confirm the expected result before moving on. When done, update the status row for this plan in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: 001 (workflow usage/cost reporting — provides the usage sink this reads)
- **Category**: dx / feature-parity
- **Planned at**: 2026-06-22

## Why this matters

The built-in dynamic-Workflow tool injects a `budget` object — `{ total, spent(), remaining() }` —
so workflow authors can scale fleets from a token target and run loop-until-budget patterns,
with `agent()` throwing once the ceiling is hit. `pi-workflow-engine` had no budget; only the
wall-clock `PerfSink`. This is the #1 feature-parity gap.

No new token accounting is required: `WorkflowUsageRecorder` (plan 001, `src/usage.ts`) already
sums each subagent's assistant-message `output` tokens, so `spent()` is
`usage.snapshot().totals.output`.

**Scope boundary**: `spent()` is per-run (this workflow + its sub-workflows, which share `rc`).
The built-in's "pool shared with the host main loop" is host-coupled and out of scope. `spent()`
counts only *completed* agents (usage is recorded on session dispose), so it lags in-flight work —
this matches the built-in's reactive accounting.

## What changed

- `src/budget.ts` (new) — `WorkflowBudgetExceededError`, the `WorkflowBudget` interface, and
  `createBudget(total, usage)`: a live closure where `remaining()` is `Infinity` when
  `total === null`, else `Math.max(0, total - spent())`.
- `src/types.ts` — `budget: WorkflowBudget` on `WorkflowApi`; `budget?: number` on `WorkflowRunOptions`.
- `src/options.ts` — resolve `budget` from `input.budget ?? PI_WORKFLOW_BUDGET`, clamped (reuses
  `optionalClampedInteger`). Always present on the resolved options (like `parallelSubmissionLimit`).
- `src/engine.ts` — `createBudget(resolvedOptions.budget ?? null, usage)` onto `rc`; exposed as
  `api.budget`. Sub-workflows inherit it via the existing `{ ...rc, signal }` spread.
- `src/agent-runner.ts` — `budget` on `RunContext`; `ensureWithinBudget(rc.budget)` called at the
  top of `runAgent`, before queuing / taking a concurrency slot.
- `index.ts` — `--budget=N` / `--budget N` parsing; `budget` tool param; `api.budget` mentioned in
  `promptGuidelines` and `buildTemporaryWorkflowAuthorPrompt`. **No `inline-workflow.ts` change** —
  `api.budget` flows to inline scripts automatically (the whole `api` is passed in).

## STOP conditions

- `ensureWithinBudget` is intentionally a **no-op stub** pending the over-budget policy decision
  (accept-overshoot vs reserve-per-agent-estimate). The test
  `runAgent refuses to start once the run is over budget` (`tests/agent-runner-model.test.ts`) is
  **red until that guard is implemented**. Do not mark this plan DONE while it is red.

## Verification

- `bun run typecheck` — clean.
- `bun test` — all green **except** the one over-budget guard test noted above (turns green once
  `ensureWithinBudget` throws `WorkflowBudgetExceededError` when `total !== null && remaining() <= 0`).
- Manual: `/workflow code-review --budget 5000 --perf` on a small diff aborts agents once output
  tokens cross 5000; an inline `dynamax` script using
  `while (api.budget.total && api.budget.remaining() > 1000) { ... }` confirms `api.budget` is
  visible to inline workflows.
