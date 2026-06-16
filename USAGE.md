# Usage

`pi-workflow-engine` adds zero-dependency Dynamax workflows to pi: opt into live, parallel subagents for the tasks that need a custom investigation instead of one long prompt. Most users only need these surfaces:

- `/workflow <name> [args]` to run a saved workflow directly.
- `/workflow:*` commands for related actions such as inspector reopening and Dynamax control.
- `dynamax` as a literal one-shot opt-in token when you want the host agent to author a one-off inline workflow for investigation/review.

## Run a workflow

From inside a repo:

```text
/workflow code-review
/workflow code-review HEAD~3
/workflow refactor-scout src/
/workflow diagnose "typecheck fails after the schema change"
/workflow perf-review "workflow startup latency"
```

The built-in workflows are advisory. They inspect, verify, and report; they do **not** edit files.

Useful flags:

```text
/workflow code-review --inspect          # show the live inspector while the run is active
/workflow:inspector                      # open the current or last workflow inspector
/workflow code-review --result-viewer    # explicitly open the findings viewer
/workflow code-review --review-viewer    # alias for --result-viewer
/workflow code-review --concurrency=4    # cap concurrent subagents
/workflow code-review --refresh          # rediscover newly added workflow files
```

## Built-in workflows

| Name | Purpose |
| --- | --- |
| `code-review` | Reviews a PR, branch diff, ref range, or focus area. |
| `refactor-scout` | Finds small, safe refactor opportunities. |
| `diagnose` | Investigates a bug, failing command, or regression. |
| `perf-review` | Reviews a slow path or performance concern. |

`code-review` auto-detects a diff when you do not pass args. If there is an open GitHub PR for the current branch, it uses that PR diff; otherwise it falls back to branch-vs-main/master or `HEAD~1`.

## Use Dynamax for custom workflows

Use `dynamax` when the built-in workflows are not specific enough and you want the main pi agent to author a temporary workflow for the current question. It is the fastest path from "this needs multiple angles" to a live fan-out, verifier pass, and synthesized result.

Interactive shortcut: run `/workflow` with no arguments, choose `✍ Author temporary one-shot workflow…`, and type a brief. pi will send that brief back to the host agent as a `dynamax` request so it can author and run an inline workflow with the `workflow` tool's `script` argument.

That inline workflow should investigate, fan out, verify, and summarize. It is **not** where code edits happen. If you want changes made, use the workflow result as evidence and then ask pi to edit separately.

One-off examples:

```text
dynamax author an inline workflow to investigate why typecheck is failing
dynamax create a one-off workflow to compare the parser and tests before we change code
dynamax use parallel agents to review this design and report the risks
```

Sticky mode and inspector shortcut:

```text
/workflow:dynamax on
/workflow:dynamax off
/workflow:dynamax status
```

The workflow inspector is also registered as a first-class shortcut shown by `/hotkeys`; the default is `ctrl+shift+m`. `ctrl+o` is intentionally not used because pi already uses it for tool-output expansion and tree filtering.

When only the literal `dynamax` token is used, the opt-in is one-shot: the next agent run receives the workflow permission reminder, stays visibly active for that run, then clears after the run ends. When `/workflow:dynamax on` is used, the opt-in is sticky for the current pi session until `/workflow:dynamax off`. Sticky mode, one-shot pending mode, and active Dynamax workflow runs show compact TUI status with `/workflow:dynamax on|off` and the inspector shortcut; off mode clears that status line.

When the host agent calls the `workflow` tool from a TUI session, pi opens the live workflow inspector for that run. The compact workflow widget still shows the latest moving status above the editor, but the inspector is the richer view for phases, agents, findings, and logs.

Configure the inspector shortcut by creating `~/.pi/agent/extensions/pi-workflow-engine.json`:

```json
{
  "shortcuts": {
    "inspector": "ctrl+shift+x"
  }
}
```

Set `"inspector": null` to disable the shortcut while keeping `/workflow:dynamax` and `/workflow:inspector` available.

With Dynamax enabled, the host agent usually calls the `workflow` tool with `script`: a one-off inline workflow tailored to your prompt. It can still call a saved workflow by `name` when one already fits.

## Workflow results

Workflow results are rendered in pi with:

- summary;
- ranked findings;
- locations and evidence;
- recommendations;
- next steps;
- run stats when available;
- workflow-level token and cost totals gathered from subagent sessions when provider usage is available.

These workflow usage totals are separate from `--perf`, which is internal timing only. They are also separate from pi's built-in footer and `/session` totals, which may still show host-session usage only unless pi core adds a first-class extension usage API. If a model has no pricing configured, token totals can be non-zero while displayed cost remains `$0.000`.

During a run, pi shows live phases and subagent status. Use `--inspect` if you want a larger live view while the workflow is active, then `/workflow:inspector` if you want to bring the last completed inspector back up afterward.

Code-review findings are rendered as a formatted result message by default. pi no longer asks whether to open the findings viewer. Use `--result-viewer` or `--review-viewer` when you want to inspect findings interactively, press `enter` to expand/collapse the nicely formatted finding text, and use `1`-`9` to jump directly to a visible finding.

## Author a saved workflow

Saved workflows are TypeScript modules with `meta` plus a default async function:

```ts
import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "my-workflow",
  description: "Find and summarize something important.",
};

const Finding = Type.Object({
  summary: Type.String(),
});

export default async function run({ agent, parallel, phase, args }: WorkflowApi) {
  phase("Find");
  const findings = await parallel([
    () => agent(`Find correctness issues: ${args}`, { schema: Finding, tools: ["read", "bash"], thinkingLevel: "low" }),
    () => agent(`Find edge cases: ${args}`, { schema: Finding, tools: ["read", "bash"], thinkingLevel: "low" }),
  ]);

  phase("Synthesize");
  return agent(`Summarize: ${JSON.stringify(findings)}`, { thinkingLevel: "medium" });
}
```

Core primitives:

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts)` | Runs one isolated subagent. With `schema`, returns validated structured data. |
| `parallel(thunks)` | Runs thunks concurrently and waits for all. |
| `pipeline(items, ...stages)` | Runs each item through stages independently. |
| `phase(title)` / `log(message)` | Updates workflow progress UI. |
| `progress(event)` | Emits counters, summaries, and lane items. |
| `workflow(ref, args?)` | Runs another workflow inline as a sub-step and returns its result. |

Set `thinkingLevel` on fan-out agents. Otherwise many subagents can inherit an expensive global reasoning level.

### Compose workflows

`workflow(ref, args?)` runs a registered workflow by name as a sub-step, returning its result. The child shares the parent run's concurrency cap, abort signal, and perf timing, and its phases nest under `<name> ▸ <phase>` in the live UI.

```ts
export default async function run({ workflow }: WorkflowApi) {
  const review = await workflow("code-review", "HEAD~3");
  return { review };
}
```

Nesting is one level only: calling `workflow()` from inside a sub-workflow rejects. Resolution throws on an unknown name — wrap the call in `try/catch` if a missing sub-workflow should be non-fatal (note `parallel()` rejects the whole batch on the first error, so catch inside each thunk for per-branch resilience).

### Where workflows live

Guaranteed built-ins are statically registered:

1. Add `.pi/extensions/pi-workflow-engine/workflows/<name>.ts`.
2. Import it in `.pi/extensions/pi-workflow-engine/src/workflows.ts`.
3. Add it to `BUILTIN_WORKFLOWS`.

Drop-in workflows are also discovered best-effort from:

- `.pi/extensions/pi-workflow-engine/workflows/*.ts`
- `~/.pi/agent/workflows/*.ts`

Use `/workflow <name> --refresh` after adding a drop-in file.

## Author an inline workflow

Inline workflows are passed to the `workflow` tool as a script string. They are useful for one-off dynamax orchestration.

```ts
export const meta = {
  name: "inline-review",
  description: "One-off focused review.",
};

export default async function run({ agent, parallel, phase, args }) {
  phase("Find");
  const Finding = Type.Object({ summary: Type.String() });
  const findings = await parallel([
    () => agent(`Find correctness issues: ${args}`, { schema: Finding, thinkingLevel: "low" }),
    () => agent(`Find edge cases: ${args}`, { schema: Finding, thinkingLevel: "low" }),
  ]);
  return { summary: JSON.stringify(findings) };
}
```

Inline rules:

- start with `export const meta = { ... }`;
- default-export an async workflow function;
- no imports or dynamic `import()`;
- use the injected `Type` object for schemas;
- no extra exports or code after the default export.

Inline workflows run in-process with extension permissions, so treat them as trusted task automation.

## Runtime knobs

Only tune these when a workflow is too slow, too expensive, or too noisy:

| Knob | Meaning |
| --- | --- |
| `--concurrency=N` / `PI_WORKFLOW_CONCURRENCY=N` | Cap concurrent subagents. Default is `min(8, max(2, CPU count))`. |
| `--parallel-limit=N` / `PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT=N` | Limit eager `parallel()` submission. |
| `--perf` / `PI_WORKFLOW_PERF=1` | Include internal timing aggregates. Usage/cost totals are reported separately from perf. |
| `PI_WORKFLOW_LANE_ITEM_LIMIT=N` | Cap retained progress lane items. |

## Common fixes

- **Unknown workflow**: confirm the extension is loaded with `pi list`; use `--refresh` for new drop-ins.
- **Inline compile error**: check the inline rules above.
- **Slow run**: lower fan-out, set `thinkingLevel`, or reduce `--concurrency`.
- **Duplicate command/tool warnings while developing**: avoid loading both the global package and the working copy.
