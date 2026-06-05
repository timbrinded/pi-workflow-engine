# Usage

`pi-workflow-engine` adds multi-agent workflows to pi. Most users only need two surfaces:

- `/workflow <name> [args]` to run a saved workflow directly.
- `dynamax` when you want the host agent to author a one-off inline workflow for investigation/review.

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
/workflow code-review --inspect          # show live inspector
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

## Use `dynamax` for inline workflows

Use `dynamax` when the built-in workflows are not specific enough and you want the main pi agent to author a temporary workflow for the current question.

That inline workflow should investigate, fan out, verify, and summarize. It is **not** where code edits happen. If you want changes made, use the workflow result as evidence and then ask pi to edit separately.

One-off examples:

```text
dynamax author an inline workflow to investigate why typecheck is failing
dynamax create a one-off workflow to compare the parser and tests before we change code
dynamax use parallel agents to review this design and report the risks
```

Sticky for the session:

```text
/dynamax on
/dynamax off
/dynamax status
```

With dynamax enabled, the host agent usually calls the `workflow` tool with `script`: a one-off inline workflow. It can still call a saved workflow by `name` when one already fits.

## Workflow results

Workflow results are rendered in pi with:

- summary;
- ranked findings;
- locations and evidence;
- recommendations;
- next steps;
- run stats when available.

During a run, pi shows live phases and subagent status. Use `--inspect` if you want a larger live view.

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

Set `thinkingLevel` on fan-out agents. Otherwise many subagents can inherit an expensive global reasoning level.

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
| `--perf` / `PI_WORKFLOW_PERF=1` | Include internal timing aggregates. |
| `PI_WORKFLOW_LANE_ITEM_LIMIT=N` | Cap retained progress lane items. |

## Common fixes

- **Unknown workflow**: confirm the extension is loaded with `pi list`; use `--refresh` for new drop-ins.
- **Inline compile error**: check the inline rules above.
- **Slow run**: lower fan-out, set `thinkingLevel`, or reduce `--concurrency`.
- **Duplicate command/tool warnings while developing**: avoid loading both the global package and the working copy.
