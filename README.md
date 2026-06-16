![agents](assets/preview.png)

# pi-workflow-engine

Zero-dependency Dynamax workflows for [pi](https://pi.dev): opt into live, parallel subagents when one coding agent is not enough.

Use `dynamax` when a task needs several independent passes: review from different angles, compare options, chase a bug through multiple suspects, or stress-test a plan. pi can spin up a temporary workflow, run focused subagents in parallel, show progress in the TUI, and return one synthesized result.

The package ships no bundled runtime dependencies. It uses the pi SDK and pi's bundled core packages, so installing it does not pull in a second agent stack.

The built-in workflows are advisory. They inspect, verify, and report; they do not edit files.

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

Useful flags:

```text
/workflow code-review --inspect
/workflow code-review --result-viewer
/workflow code-review --no-result-viewer
/workflow code-review --concurrency=4
/workflow code-review --refresh
```

The code-review workflow can open an interactive findings viewer. Select findings and hand them back to the parent agent for minimal fixes, or ask it to raise GitHub PR comments when `gh` is authenticated and PR context is available.

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
- A single run-level semaphore caps concurrent agents, so nested `parallel`, `pipeline`, and `workflow()` calls stay bounded.
- Built-in workflows stay statically imported so they share pi's bundled `typebox` identity.
- Set `thinkingLevel` per fan-out agent. Otherwise many subagents can inherit an expensive global reasoning level.

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
