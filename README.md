![agents](assets/preview.png)

# pi-workflow-engine

Zero-dependency Dynamax workflows for [pi](https://pi.dev): opt into live, parallel subagents when one coding agent is not enough.

Use `dynamax` when a task needs several independent passes: review from different angles, compare options, chase a bug through multiple suspects, or stress-test a plan. pi can spin up a temporary workflow, run focused subagents in parallel, show progress in the TUI, and return one synthesized result.

The package ships no bundled runtime dependencies. It uses the pi SDK and pi's bundled core packages, so installing it does not pull in a second agent stack.

The built-in workflows are advisory by default. They inspect, verify, and report; they do not edit files. Workflow authors can opt individual subagents into disposable git worktrees when they want reviewable patches instead of direct edits.

## Install

```bash
pi install npm:pi-workflow-engine
```

Or install from GitHub:

```bash
pi install git:github.com/timbrinded/pi-workflow-engine
```

Restart pi, or run `/reload` in an open session, then confirm it loaded:

```bash
pi list
```

For project-local install:

```bash
pi install npm:pi-workflow-engine -l
```

## Use Dynamax

Put the word `dynamax` in your prompt when you want pi to use a custom multi-agent workflow for the current task.

```text
dynamax investigate why typecheck started failing after this branch
```

What to expect:

1. pi decides whether a saved workflow fits or whether to write a one-off workflow.
2. The workflow runs focused subagents in parallel.
3. You can watch phases, agents, findings, and logs in the workflow inspector.
4. You get a summarized result with evidence, risks, next steps, and workflow-level token/cost totals gathered from subagent sessions.
5. You can then ask pi to make changes using that result.

Workflow usage totals are reported on the workflow result itself. pi's built-in footer and `/session` stats may still show host-session usage only unless pi core adds a first-class extension usage API.

Dynamax is one-shot by default. It applies to the next agent run and then clears. Keep it on for the session with:

```text
/workflow:dynamax on
/workflow:dynamax status
/workflow:dynamax off
```

The workflow inspector is available with:

```text
/workflow:inspector
```

In interactive mode, `/workflow` with no arguments also offers `Author temporary one-shot workflow...`. Choose it, type a brief, and pi will ask the host agent to write and run a temporary workflow.

## Example Dynamax Prompts

Use Dynamax when you want breadth, independent judgment, or adversarial pressure before editing.

```text
dynamax do an adversarial review of this branch. I want correctness bugs, hidden coupling, test gaps, and over-engineered parts called out separately.
```

Expected result: several review angles run independently, likely findings are verified, duplicates are merged, and you get a ranked report with concrete evidence before deciding what to fix.

```text
dynamax investigate this flaky test. Split the work between recent diffs, test setup, async timing, and external dependencies.
```

Expected result: parallel hypotheses, evidence for or against each one, and the most likely root cause with a small validation step.

```text
dynamax compare these two implementation approaches and argue both sides before recommending one.
```

Expected result: separate agents inspect each approach, another pass looks for failure modes, and the final answer separates tradeoffs from the recommendation.

```text
dynamax review this migration plan like a hostile reviewer. Focus on rollback, data loss, concurrency, and missing operational steps.
```

Expected result: an adversarial checklist with concrete risks, what would break, and which items are blockers versus follow-ups.

```text
dynamax find the simplest safe refactor path for this module. Avoid broad rewrites.
```

Expected result: small refactor opportunities, why they are safe, and what not to touch.

```text
dynamax inspect this performance issue. Separate measurement gaps from real bottleneck hypotheses.
```

Expected result: a performance-focused report that distinguishes known evidence from guesses and suggests the next measurement command.

## Saved Workflows

You can also run saved workflows directly:

```text
/workflow code-review
/workflow code-review HEAD~3
/workflow refactor-scout src/
/workflow diagnose "typecheck fails after the schema change"
/workflow perf-review "workflow startup latency"
```

Built-ins:

- `code-review`: reviews a PR, branch diff, ref range, or target.
- `refactor-scout`: finds small, safe refactor opportunities.
- `diagnose`: investigates a bug, failing command, or regression.
- `perf-review`: reviews a slow path or performance concern.

PR reviews always use the cumulative pull-request diff. Per-commit `gh pr diff --patch` input is rejected, and a failed diff capture fails the review instead of being reported as an empty or clean diff.

Useful flags:

```text
/workflow code-review --inspect
/workflow code-review --result-viewer
/workflow code-review --no-result-viewer
/workflow:results
/workflow code-review --concurrency=4
/workflow code-review --budget=50000
/workflow code-review --resume <run-id>
/workflow code-review --refresh
```

Every workflow result includes a run id. If a long run is interrupted, rerun the same workflow with `--resume <run-id>`. Replay contract v2 is fail-closed: shared-workspace agents run live unless their author sets `resume: "read-only"`, worktree-isolated agents are replayable by default, and `resume: "off"` disables replay for either kind.

A cache hit requires the same prompt/options, repository-wide Git-visible state, explicitly declared ignored inputs, workflow provenance, coding-agent runtime, effective system prompt/model/thinking level, ordered selected skills, and executable active-tool identity. Cached text, structured output, and isolated patches are validated against the current schema or fresh worktree before use. Repository, skill, and session identity are checked again after execution; the repository is checked once more after cleanup, so a stale hit becomes a live run. Legacy entries without the effective-session identity can be read but always miss. Git-ignored files are captured only when listed in cwd-relative `resumeInputs`; tracked symlinks/submodules and unsafe declared inputs fail closed. Use `resume: "off"` for uncaptured files, external services, environment, or clock-dependent calls.

The code-review workflow can open a centred, terminal-proportional interactive findings viewer. Reopen the latest code-review findings in the current pi session without rerunning it with `/workflow:results` or `ctrl+shift+r`; the shortcut is shown by `/hotkeys`. Its Fix action revalidates the exact reviewed PR/ref/index/working-tree snapshot, runs one focused agent per selected finding from that snapshot in a disposable git worktree, and returns independent patch previews without modifying your active tree. If the reviewed target moved or cannot be verified, patch generation fails closed instead of producing a patch against the wrong code.

The original review and every retained Fix preview share one session-scoped output-token budget; reopening the viewer does not reset it, and only one preview can run at a time. GitHub comments are available only when the review came from a verified PR target; the action revalidates the snapshot and current PR head, then skips identical existing comments before writing through authenticated `gh`.

For the full command guide, see [USAGE.md](USAGE.md).

## What Dynamax Is Good For

Use it for:

- adversarial reviews before you trust a plan or diff;
- debugging where several causes are plausible;
- design comparisons where you want both sides argued;
- refactor scouting where broad rewrites would be risky;
- performance investigations where measurement gaps matter;
- documentation reviews where consistency and reader expectations both matter.

Do not use it for every tiny task. A single prompt is still better for simple edits, one-file explanations, and obvious mechanical changes.

## Local Development

Only needed if you want to add workflows, customize workflows, or contribute. Using the package does not require a clone, install, or build step.

```bash
git clone https://github.com/timbrinded/pi-workflow-engine
cd pi-workflow-engine
bun install
bun run typecheck
bun run test
```

Load your working copy through the package manifest without installing it:

```bash
pi -e .
```

If you also have the global package installed, pi may report duplicate `/workflow` or `workflow` tool diagnostics. Remove one source or load only this working copy:

```bash
pi -ne -e .
```

### Add A Workflow

A workflow is a TypeScript module that exports `meta` plus a default async function. The `api` object gives you `agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, and `progress`.

Guaranteed built-ins are statically registered:

1. Add `.pi/extensions/pi-workflow-engine/workflows/<name>.ts`.
2. Import it in `.pi/extensions/pi-workflow-engine/src/workflows.ts`.
3. Add it to `BUILTIN_WORKFLOWS`.

Drop-in workflows are also discovered best-effort from:

- `.pi/extensions/pi-workflow-engine/workflows/*.ts`
- `~/.pi/agent/workflows/*.ts`

Use `/workflow <name> --refresh` after adding a drop-in file.

Inline workflows are passed to the `workflow` tool as a script string. They are useful for one-off Dynamax orchestration. Inline v1 rules: no imports, no dynamic `import()`, pure-literal `meta`, schemas must use the injected `Type` value, and scripts run in-process with the extension's permissions.

### Technical Notes

- Each `agent()` runs an in-process pi `AgentSession` with `SessionManager.inMemory()`.
- Workflow results aggregate the finalized assistant usage from those subagent sessions before disposal and show token/cost totals separately from pi's host-session footer accounting.
- Structured output uses a terminating tool whose `parameters` is your schema. pi validates the call; the engine captures the args. There is no JSON scraping.
- A schema agent that finishes without calling `final_answer` is re-prompted once before returning `null`.
- Runs write replay-safe completed `agent()` results and their v2 execution identity to `.pi/.workflow-runs/<run-id>.jsonl`; a resumed run writes a fresh journal. Shared agents opt in with `resume: "read-only"` and automatically bind Git-visible state from the repository root; `resumeInputs` adds ignored/generated paths under the workflow cwd. Worktree-isolated agents replay from the exact immutable commit and tree prepared for their disposable workspace by default, so same-tree history changes still invalidate. Synthetic unborn and reviewed-snapshot commits use deterministic metadata to keep unchanged identities stable. Tracked symlinks, submodules, and unsafe declared inputs disable replay rather than weakening identity. Built-in synthesis stages opt in with no workspace tools; discovery-loaded workflow module graphs remain live because their transitive runtime code is not immutable.
- `agent(..., { isolation: "worktree" })` runs in a disposable git worktree and returns `{ result, patch, changed }`; the user working tree is not mutated. If required worktree cleanup still fails after all removals are attempted, the workflow fails and reports the cleanup error.
- A single run-level semaphore caps concurrent agents, so nested `parallel`, `pipeline`, and `workflow()` calls stay bounded.
- `parallel()` and `pipeline()` are fail-soft: recoverable branch failures, including budget backstops, become `null` slots while survivors continue. `parallel(thunks, { settled: true })` retains serialisable success/error outcomes instead; a genuine run abort still rejects.
- Built-in workflows stay statically imported so they share pi's bundled `typebox` identity.
- Set `thinkingLevel` per fan-out agent. Otherwise many subagents can inherit an expensive global reasoning level.
- Subagents receive no skills by default. Opt in per agent with `skills: ["skill-name"]`; clear prompt text like `include skill name` also works when `skills` is omitted.
- `tools` is a strict allowlist for subagents. Use `toolHints: ["search"]` to dynamically expose installed grep/find/search-like tools such as `ast-grep`, `mgrep`, `ffgrep`, or `fffind` without hard-coding a specific extension.
- Set `model` per agent only when needed: bare ids are Anthropic shorthand, and `provider/id` targets other providers.
  Omitted models inherit the host/session default; malformed or unknown explicit refs fail fast.

### Performance Controls

Runtime controls:

- `PI_WORKFLOW_PERF=1` enables per-run performance timing. This is timing-only; workflow usage/cost totals are reported separately when subagent usage is available.
- `PI_WORKFLOW_CONCURRENCY=N` sets the per-run agent cap. The default is `min(8, max(2, CPU count))`.
- `PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT=N` limits how many `parallel()` thunks are submitted at once.
- `PI_WORKFLOW_LANE_ITEM_LIMIT=N` caps retained progress lane items per lane.

No-LLM benchmark scripts:

```bash
bun run bench:concurrency -- --items 200 --concurrency 8 --json
bun run bench:discovery -- --iterations 3 --json
bun run bench:startup -- --json
bun run bench:ui -- --agents 1000 --lane-items 1000 --json
```

### Layout

```text
.pi/
  settings.json
  extensions/pi-workflow-engine/
    index.ts
    src/
      types.ts
      agent-runner.ts
      concurrency.ts
      engine.ts
      progress.ts
      discovery.ts
      workflows.ts
    workflows/
      code-review.ts
      refactor-scout.ts
      diagnose.ts
      perf-review.ts
```
