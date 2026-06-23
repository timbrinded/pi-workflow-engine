# Plan 003: Harden workflow budget parsing, enforcement, and docs

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md` — unless a reviewer dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a8f0a0..HEAD -- .pi/extensions/pi-workflow-engine/index.ts .pi/extensions/pi-workflow-engine/src/options.ts .pi/extensions/pi-workflow-engine/src/agent-runner.ts .pi/extensions/pi-workflow-engine/src/types.ts .pi/extensions/pi-workflow-engine/src/budget.ts tests/workflow-options.test.ts tests/budget.test.ts tests/agent-runner-model.test.ts tests/workflow-tool.test.ts README.md USAGE.md plans/002-workflow-token-budget.md plans/README.md`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/002-workflow-token-budget.md
- **Category**: bug / tests / docs / tech-debt
- **Planned at**: commit `8a8f0a0`, 2026-06-23

## Why this matters

The workflow budget feature is meant to give workflow authors and host agents a reliable output-token ceiling. The current implementation has three correctness gaps: user-facing `--budget` parsing can silently drop invalid values and positional args, option resolution can let invalid numeric values survive, and queued agents are not re-checked after waiting for the semaphore. The cleanup work is also important because public docs omit the new knob, regression coverage only exercises happy paths, and stale plan/test comments still describe the budget guard as a future/red contribution.

## Current state

Relevant files and their roles:

- `.pi/extensions/pi-workflow-engine/index.ts` — extension entrypoint; parses `/workflow` slash-command flags and declares the `workflow` tool schema.
- `.pi/extensions/pi-workflow-engine/src/options.ts` — resolves `WorkflowRunOptions` from explicit options and environment variables.
- `.pi/extensions/pi-workflow-engine/src/agent-runner.ts` — runs each subagent and enforces `WorkflowBudget` before spending.
- `tests/workflow-options.test.ts`, `tests/budget.test.ts`, `tests/agent-runner-model.test.ts`, `tests/workflow-tool.test.ts` — no-LLM regression tests for options, budget accounting, agent startup, and tool behavior.
- `README.md`, `USAGE.md`, `plans/002-workflow-token-budget.md`, `plans/README.md` — user docs and existing implementation-plan index.

Current budget parsing behavior in `.pi/extensions/pi-workflow-engine/index.ts:231-297`:

```ts
function parseWorkflowOptions(input: string): { args: string; options: WorkflowRunOptions; refreshDiscovery?: boolean } {
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const options: WorkflowRunOptions = {};
  // ...
  if (token.startsWith("--budget=")) {
    options.budget = parseNumericOption(token.slice("--budget=".length));
    continue;
  }
  if (token === "--budget") {
    const next = tokens[i + 1];
    options.budget = parseNumericOption(next);
    if (next !== undefined) i++;
    continue;
  }
  kept.push(token);
}

function parseNumericOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
```

Implications to fix:

- `/workflow code-review --budget review src` consumes `review` as the missing numeric value, drops it from `args`, and runs unbudgeted.
- `/workflow code-review --budget=abc review src` drops the invalid flag and runs unbudgeted.
- The parse result has no error channel for the command handler to notify and stop.

Current option resolution in `.pi/extensions/pi-workflow-engine/src/options.ts:15-49`:

```ts
const budget = optionalClampedInteger(input.budget ?? parseInteger(env.PI_WORKFLOW_BUDGET), 1, 1_000_000_000);

function optionalClampedInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  return clampInteger(value, min, max, value);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
```

Implication to fix: when `optionalClampedInteger` receives an explicit non-finite number, its fallback is the same invalid value, so a bad budget can become `NaN`; `remaining()` then becomes `NaN`, and `remaining() <= 0` never trips.

Current enforcement in `.pi/extensions/pi-workflow-engine/src/agent-runner.ts:252-300`:

```ts
function ensureWithinBudget(budget: WorkflowBudget): void {
  if (budget.total !== null && budget.remaining() <= 0) {
    throw new WorkflowBudgetExceededError(budget.total, budget.spent());
  }
}

export async function runAgent(rc: RunContext, prompt: string, opts: AgentOptions = {}): Promise<unknown> {
  // ...
  throwIfAborted(rc.signal);
  // Stop spending the moment the run is over budget — before queueing or taking a slot.
  ensureWithinBudget(rc.budget);
  // Track queued agents before acquiring a global concurrency slot.
  const rowId = rc.progress.agentQueued(opts.phase, label);
  let failureHandled = false;
  try {
    return await rc.semaphore.run(
      async () => {
      throwIfAborted(rc.signal);
      rc.progress.agentStart(opts.phase, label, rowId);
```

Implication to fix: agents submitted while the budget is still available pass the pre-queue guard. If they wait behind the semaphore and an earlier agent exhausts the budget, they can still start because there is no second guard after acquiring the slot.

Current stale cleanup targets:

- `tests/agent-runner-model.test.ts:220` says `// Target for the ensureWithinBudget contribution: red until the guard is implemented.` The test is now green.
- `plans/002-workflow-token-budget.md:46-57` still says the guard is a no-op stub and `bun test` is green except the budget test. That is no longer true.
- `README.md:132-138` lists useful `/workflow` flags but omits `--budget`.
- `USAGE.md:221-226` lists runtime knobs but omits `--budget=N` / `PI_WORKFLOW_BUDGET=N`.

Repo conventions to match:

- Keep TypeScript strict and avoid `as any` (see `AGENTS.md`).
- Tests use Bun's built-in runner plus `node:assert/strict`; follow nearby tests in `tests/workflow-options.test.ts` and `tests/agent-runner-model.test.ts`.
- Runtime options are currently clamped to bounded integers in `.pi/extensions/pi-workflow-engine/src/options.ts`; do not introduce a new dependency for parsing.
- Public tool schemas are declared with TypeBox `Type.*` in `.pi/extensions/pi-workflow-engine/index.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Focused budget tests | `bun test tests/budget.test.ts tests/workflow-options.test.ts tests/agent-runner-model.test.ts tests/workflow-tool.test.ts` | exit 0, all tests pass |
| Typecheck | `bun run typecheck` | exit 0, no diagnostics |
| Full test suite | `bun run test` | exit 0, all tests pass |
| Stale-text check | `rg -n "red until|no-op stub|all green \*\*except" tests/agent-runner-model.test.ts plans/002-workflow-token-budget.md` | exit 1, no matches |

## Scope

**In scope** (the only files you should modify):

- `.pi/extensions/pi-workflow-engine/index.ts`
- `.pi/extensions/pi-workflow-engine/src/options.ts`
- `.pi/extensions/pi-workflow-engine/src/agent-runner.ts`
- `.pi/extensions/pi-workflow-engine/src/types.ts` only if a narrow type addition is required for parse errors or constants
- `.pi/extensions/pi-workflow-engine/src/budget.ts` only if a narrow budget validation helper belongs there after reading the code
- `tests/workflow-options.test.ts`
- `tests/budget.test.ts`
- `tests/agent-runner-model.test.ts`
- `tests/workflow-tool.test.ts`
- `README.md`
- `USAGE.md`
- `plans/002-workflow-token-budget.md`
- `plans/README.md`

**Out of scope** (do NOT touch, even though related):

- Adding cost-dollar budgets; this plan is only for output-token budgets.
- Reserving estimated output tokens per queued/running agent; accepted overshoot from already-running agents stays by design.
- Changing the `WorkflowBudget` public shape `{ total, spent(), remaining() }`.
- Changing built-in workflow fan-out sizes or prompts.
- Integrating subagent usage into pi's host footer/session token accounting.
- Refactoring unrelated numeric flags (`--concurrency`, `--parallel-limit`) beyond shared helper changes needed to avoid duplicating budget parsing mistakes.

## Git workflow

- Stay on the current feature branch unless the operator asks for a new branch.
- Use conventional commit style if committing later, matching recent history: e.g. `fix: harden workflow budget enforcement`.
- Do not push or open a PR unless explicitly instructed.

## Steps

### Step 1: Add failing regression tests for the three correctness findings

Add or extend tests before changing implementation.

In `tests/workflow-options.test.ts`, cover slash-command budget parsing:

- Valid forms keep working: `--budget=50000` and `--budget 50000` both set `options.budget` to `50000` and preserve positional args.
- Missing/invalid forms are not silently accepted: `--budget`, `--budget=`, `--budget=abc`, and `--budget review src` must return a parse error that the command handler can surface instead of running unbudgeted.
- For `--budget review src`, the parser must not consume `review` as an invalid value and lose it from `args`; either preserve `args: "review src"` in the parse result or fail before args are used. Prefer preserving it because it makes parse errors easier to display/debug.
- Non-positive and non-integer budget strings (`0`, `-1`, `1.5`) must be rejected at the user-facing parser. Token budgets are positive integers.

Recommended API shape: add an optional `optionErrors?: string[]` (or equivalent) to the parse result. Keep the property absent on successful parses so existing deep-equality tests do not need noisy `undefined` fields.

In `tests/budget.test.ts` or `tests/workflow-options.test.ts`, cover option resolution:

- `resolveWorkflowRunOptions({}, { PI_WORKFLOW_BUDGET: "50000" }).budget === 50000`.
- Invalid env values such as `"abc"`, `""`, `"0"`, and `"1.5"` do not produce `NaN`; choose and document either "unset" or "error" for env. Prefer unset for env because there is no UI context to report errors.
- An explicit non-finite budget (`Number.NaN`, `Infinity`) never reaches `createBudget` as `NaN`/`Infinity`. Prefer throwing a clear `RangeError` for explicit programmatic invalid values; if you choose to unset instead, add a comment explaining why that is safe.

In `tests/agent-runner-model.test.ts`, cover queued-agent enforcement:

- Use the existing `createRunContext` helper and `Semaphore(1)` pattern.
- Start two `runAgent` calls concurrently with the same `RunContext` and a custom live `WorkflowBudget` whose `spent()` becomes equal to `total` after the first session prompts.
- Assert the first call fulfills, the second rejects with `WorkflowBudgetExceededError`, and the fake `createSession` is called only once. This proves the queued second agent re-checks after acquiring the semaphore and does not create a subagent session.
- Assert progress records a failure for the second queued row, not a successful start/done.

In `tests/workflow-tool.test.ts`, add coverage only if needed for a tool-schema or run-options change. Do not instantiate real LLM sessions.

**Verify**: `bun test tests/budget.test.ts tests/workflow-options.test.ts tests/agent-runner-model.test.ts tests/workflow-tool.test.ts` → expected to fail on the new tests before implementation and pass existing tests.

### Step 2: Harden budget parsing and option normalization

Implement the minimum parsing/normalization changes needed for Step 1.

In `.pi/extensions/pi-workflow-engine/src/options.ts`:

- Export shared budget bounds, e.g. `WORKFLOW_BUDGET_MIN = 1` and `WORKFLOW_BUDGET_MAX = 1_000_000_000`, so CLI parsing, tool schema, and resolver cannot drift.
- Fix `optionalClampedInteger` so it cannot return a non-finite number. Do not use the candidate value itself as fallback when the candidate may be non-finite.
- For budget specifically, use strict positive-integer parsing for environment values. Invalid env values should not become `NaN` and should not clamp `0` to `1` silently unless you explicitly document that choice in code and tests.
- For explicit `input.budget`, reject non-finite values deterministically. A clear `RangeError` is preferable to silently disabling a requested budget.

In `.pi/extensions/pi-workflow-engine/index.ts`:

- Replace `parseNumericOption` for `--budget` with a budget-specific parser that returns either `{ value }` or `{ error }`.
- For `--budget VALUE`, consume `VALUE` only when it is a syntactically valid positive integer. If it is missing or invalid, record an option error and do not drop the following positional arg.
- Extend the `/workflow` command handler to check parse errors before discovering/running workflows. Notify the user with a concise message such as `Invalid workflow option: --budget requires a positive integer output-token count` and return without running.
- Keep successful parse behavior for `--inspect`, `--refresh`, `--perf`, result-viewer flags, `--concurrency`, and `--parallel-limit` unchanged unless the shared helper requires a narrow internal refactor.
- Tighten the `workflow` tool parameter schema for `budget` from `Type.Number(...)` to an integer schema with the same min/max bounds, e.g. `Type.Integer({ minimum: WORKFLOW_BUDGET_MIN, maximum: WORKFLOW_BUDGET_MAX, description: ... })`, if TypeBox supports it in this repo's dependency. If `Type.Integer` is not available, keep `Type.Number` but validate through `resolveWorkflowRunOptions` and add a test or comment.

**Verify**: `bun test tests/budget.test.ts tests/workflow-options.test.ts tests/workflow-tool.test.ts` → all pass.

### Step 3: Re-check the budget after queued agents acquire the semaphore

In `.pi/extensions/pi-workflow-engine/src/agent-runner.ts`:

- Keep the existing pre-queue `ensureWithinBudget(rc.budget)` so already-exhausted runs fail before adding more queued rows.
- Add a second `ensureWithinBudget(rc.budget)` inside the `rc.semaphore.run(async () => { ... })` callback, immediately after `throwIfAborted(rc.signal)` and before `rc.progress.agentStart(...)` or session creation.
- Update the comment above `ensureWithinBudget` and the run-agent comments to say budget is checked both before queueing and before starting after a queue wait.
- Preserve the current policy: overshoot from agents that are already running concurrently is allowed because usage is only known after completed sessions; this plan only prevents stale queued work from starting after the budget is exhausted.
- Ensure error handling still marks an already-queued row failed when the second guard throws, and does not call `agentDone` for that row.

**Verify**: `bun test tests/agent-runner-model.test.ts` → all pass, including the new queued-agent regression.

### Step 4: Clean up docs and stale implementation notes

Update user-facing docs:

- In `README.md`, add a useful flag example for `--budget`, e.g. `/workflow code-review --budget=50000`, near the existing `/workflow code-review --concurrency=4` example.
- In `USAGE.md`, add `--budget=N` / `PI_WORKFLOW_BUDGET=N` to the Runtime knobs table. Describe it as an output-token ceiling for completed subagents; `agent()` throws `WorkflowBudgetExceededError` once the ceiling has been reached before starting another agent. Mention that already-running agents may overshoot because there is no per-agent token reservation.
- In `USAGE.md` Common fixes, add a concise budget-exhausted note: narrow the target, raise `--budget`, reduce fan-out/concurrency, or guard loops with `api.budget.remaining()`.

Update stale internal plan/test text:

- In `tests/agent-runner-model.test.ts`, replace the stale `red until` comment with a neutral regression-test comment or delete it.
- In `plans/002-workflow-token-budget.md`, update the title/status language from "Token/cost" to "output-token" where appropriate, remove the obsolete STOP condition claiming `ensureWithinBudget` is a no-op stub, and update Verification to say the guard test is expected to pass.
- In `plans/README.md`, update Plan 002's title if changed and add/keep this Plan 003 row as `TODO` until execution is complete.

**Verify**:

- `rg -n "red until|no-op stub|all green \*\*except" tests/agent-runner-model.test.ts plans/002-workflow-token-budget.md` → no matches, exit 1.
- `rg -n -- "--budget|PI_WORKFLOW_BUDGET|output-token" README.md USAGE.md plans/002-workflow-token-budget.md` → shows the new/updated docs.

### Step 5: Run full gates and review the diff for scope

Run the full repo gates:

1. `bun run typecheck` → exit 0, no diagnostics.
2. `bun run test` → exit 0, all tests pass.
3. `git diff --stat` → only in-scope files changed.
4. `git diff -- .pi/extensions/pi-workflow-engine/index.ts .pi/extensions/pi-workflow-engine/src/options.ts .pi/extensions/pi-workflow-engine/src/agent-runner.ts tests README.md USAGE.md plans` → review that the diff matches the six findings and does not include opportunistic refactors.

If the full suite fails in tests unrelated to this plan, re-run the focused budget tests. If focused tests pass but unrelated tests fail, record the unrelated failure and STOP instead of broadening scope.

## Test plan

New/updated tests must cover:

- CLI budget happy paths: `--budget=N` and `--budget N`.
- CLI budget invalid/missing/non-positive/non-integer paths: no silent unbudgeted run and no accidental positional-arg consumption.
- Env/programmatic budget normalization: invalid values never resolve to `NaN`/`Infinity`.
- Tool schema/normalization for budget accepts only positive integer values within bounds.
- Agent enforcement before queueing still rejects already-exhausted runs without creating a session.
- Agent enforcement after queue wait rejects a queued second agent after a first agent exhausts the budget.
- Existing no-budget behavior remains unchanged: `budget.total === null`, `spent()` live, `remaining() === Infinity`.

Use existing tests as patterns:

- Parser tests: `tests/workflow-options.test.ts`.
- Live budget accounting: `tests/budget.test.ts`.
- Fake subagent sessions and progress assertions: `tests/agent-runner-model.test.ts`.
- Workflow tool request/inline harness: `tests/workflow-tool.test.ts` if needed.

Verification: `bun test tests/budget.test.ts tests/workflow-options.test.ts tests/agent-runner-model.test.ts tests/workflow-tool.test.ts` and then `bun run test` must both pass.

## Done criteria

All must hold:

- [ ] `/workflow` slash-command budget parse errors are user-visible and abort the run instead of silently running unbudgeted.
- [ ] Invalid or non-finite budget values cannot produce `NaN`/`Infinity` in `ResolvedWorkflowRunOptions` or `WorkflowBudget.total`.
- [ ] Queued agents re-check budget after semaphore acquisition and before session creation.
- [ ] Docs mention `--budget=N` and `PI_WORKFLOW_BUDGET=N`, including output-token-only semantics and allowed overshoot from already-running agents.
- [ ] Stale "red until" / "no-op stub" text is gone.
- [ ] `bun run typecheck` exits 0.
- [ ] `bun run test` exits 0.
- [ ] `git status --short` shows only intentional in-scope file changes.
- [ ] `plans/README.md` has this plan row marked `DONE` after execution.

## STOP conditions

Stop and report back if:

- The drift check shows changes to in-scope code and the excerpts above no longer match.
- Tightening budget parsing would require changing public behavior for non-budget flags in a way not covered by existing tests.
- TypeBox in this runtime does not support `Type.Integer` and no clean fallback validation path is obvious.
- The queued-agent regression requires changing `Semaphore`, `parallel`, or `pipeline`; this plan should only touch `runAgent` enforcement.
- A verification command fails twice after a reasonable fix attempt.
- The fix appears to require adding cost-dollar budgeting, token reservation estimates, or host-session usage accounting.

## Maintenance notes

- Budget enforcement remains reactive: completed subagents update usage, and already-running agents may overshoot the ceiling. Reviewers should reject attempts to add fake token reservations in this plan.
- Keep budget bounds/constants shared between slash parsing, tool schema, and option resolution to prevent drift.
- If future workflow options add user-facing numeric flags, copy the parse-error pattern from this budget fix rather than returning `undefined` for invalid input.
- If pi later exposes a host-level subagent budget API, revisit `WorkflowBudget.spent()` semantics; this plan intentionally stays per workflow run.
