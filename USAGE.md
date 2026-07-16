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

The built-in workflows are advisory by default. They inspect, verify, and report; they do **not** edit files. Saved or inline workflows can opt individual agents into disposable git worktrees when they need reviewable patches.

Useful flags:

```text
/workflow code-review --inspect          # show the live inspector while the run is active
/workflow:inspector                      # open the current or last workflow inspector
/workflow code-review --result-viewer    # explicitly open the findings viewer
/workflow code-review --review-viewer    # alias for --result-viewer
/workflow code-review --concurrency=4    # cap concurrent subagents
/workflow code-review --budget=50000     # output-token ceiling for subagents
/workflow code-review --resume <run-id>  # replay matching completed agent calls
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

### Adaptive multi-pass authoring

A single fan-out is still the default when it can answer the question. When the first pass may reveal gaps, conflicts, weak claims, or missing evidence, an inline workflow can inspect those intermediate results and commission only the follow-up work the LLM says is needed:

```ts
const firstPass = (await api.parallel(initialTasks)).filter((result) => result !== null);

const MAX_FOLLOW_UPS = 4;
const GapAnalysis = Type.Object({
  items: Type.Array(
    Type.Object({ question: Type.String(), reason: Type.String() }),
    { maxItems: MAX_FOLLOW_UPS },
  ),
});
const gaps = await api.agent(
  `Identify only material gaps that require another agent:\n${JSON.stringify(firstPass)}`,
  { schema: GapAnalysis, thinkingLevel: "low" },
);

const followUpItems = gaps?.items.slice(0, MAX_FOLLOW_UPS) ?? [];
const followUps = followUpItems.length
  ? (await api.parallel(
      followUpItems.map((item) => () =>
        api.agent(`Resolve this gap and cite evidence: ${JSON.stringify(item)}`, {
          thinkingLevel: "low",
        }),
      ),
    )).filter((result) => result !== null)
  : [];

return api.agent(
  `Synthesize the first pass and any follow-ups:\n${JSON.stringify({ firstPass, followUps })}`,
  { thinkingLevel: "medium" },
);
```

The structured gap-analysis result lets ordinary TypeScript decide whether a second pass exists. Put a hard `maxItems` bound on LLM-authored task lists and defensively slice before fan-out. Prefer conditionals and bounded loops over new iteration, quorum, graph, reduction, or retry primitives, and do not generate follow-up agents when the first pass is already sufficient.

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

Code-review findings are rendered as a formatted result message by default. pi no longer asks whether to open the findings viewer. Use `--result-viewer` or `--review-viewer` when you want to inspect findings interactively, press `enter` to expand/collapse the nicely formatted finding text, and use `1`-`9` to jump directly to a visible finding. The Fix action revalidates the exact reviewed PR/ref/index/working-tree snapshot, then runs each selected finding through its own worktree-isolated agent and returns the finding ID, validation summary, patch, and changed status. Failed attempts do not discard successful previews, no patch is applied to your active tree automatically, and a moved or unverifiable review target is rejected rather than patched against the wrong code.

### Resume a run

Every workflow result includes a run id. Resume with:

```text
/workflow code-review --resume <run-id> HEAD~3
```

The `workflow` tool exposes the same feature as `resumeFromRunId`. Resume replays a completed `agent()` result from `.pi/.workflow-runs/<run-id>.jsonl` only when both its prompt/options identity and execution context still match. The execution context includes the repository state and HEAD, staged/unstaged/untracked content, workflow name and source, and the effective resolved provider/model. Each missing or invalidated call runs live while other independently matching calls may still replay, and the resumed run writes a fresh journal under its new run id. Cached results do not add usage or budget spend for the resumed run.

Invalidations appear in progress output with a concise reason. Legacy journals without execution context are accepted as input but their unverifiable entries run live. Git repositories with no commits and non-Git directories remain supported; the journal directory itself is excluded from the dirty-tree fingerprint.

Saved file-backed workflows fingerprint their bounded package source tree so imported helper changes invalidate replay, while inline workflows use the compiler-provided script fingerprint. Programmatic modules without explicit `source` provenance are intentionally non-replayable because captured closures and external helpers cannot be verified safely.

Resume only caches completed `agent()` calls. It does not snapshot arbitrary workflow local variables, in-flight tool work, or external service state. Keep prompts and agent options deterministic across reruns if you want cache hits.

## Author a saved workflow

Saved workflows are TypeScript modules with `meta` plus a default async function:

```ts
import { Type } from "typebox";
import { compactResults } from "../src/concurrency.ts";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "my-workflow",
  description: "Find and summarize something important.",
};

const Finding = Type.Object({
  summary: Type.String(),
});
const SEARCH_TOOLS = ["read", "bash", "grep", "find", "ls"];
const SEARCH_TOOL_HINTS = ["search"] as const;

export default async function run({ agent, parallel, phase, args }: WorkflowApi) {
  phase("Find");
  const findings = compactResults(
    await parallel([
      () => agent(`Find correctness issues: ${args}`, { schema: Finding, tools: SEARCH_TOOLS, toolHints: SEARCH_TOOL_HINTS, thinkingLevel: "low" }),
      () => agent(`Find edge cases: ${args}`, { schema: Finding, tools: SEARCH_TOOLS, toolHints: SEARCH_TOOL_HINTS, thinkingLevel: "low" }),
    ]),
  );

  phase("Synthesize");
  return agent(`Summarize: ${JSON.stringify(findings)}`, { thinkingLevel: "medium" });
}
```

Core primitives:

| Primitive | What it does |
| --- | --- |
| `agent(prompt, opts)` | Runs one isolated subagent. With `schema`, returns validated structured data. |
| `parallel(thunks)` | Runs thunks concurrently and waits for all; recoverable failures become `null` slots. |
| `parallel(thunks, { settled: true })` | Retains each success or recoverable failure as a serialisable discriminated result. |
| `pipeline(items, ...stages)` | Runs each item through stages independently; a failed item becomes `null`. |
| `phase(title)` / `log(message)` | Updates workflow progress UI. |
| `progress(event)` | Emits counters, summaries, and lane items. |
| `workflow(ref, args?)` | Runs another workflow inline as a sub-step and returns its result. |

Use settled mode when the workflow must distinguish a successful `null` from a failed branch. It preserves input order and returns `{ ok: true, value }` or `{ ok: false, error: { name?, message } }` for every thunk. Genuine workflow cancellation still rejects the whole `parallel()` call and cancels siblings.

Set `thinkingLevel` on fan-out agents. Otherwise many subagents can inherit an expensive global reasoning level.

`tools` is a strict allowlist. If you set `tools: ["read", "bash"]`, extension tools such as `ast-grep`, `mgrep`, `fffind`, or `ffgrep` are hidden from that subagent. Add `toolHints: ["search"]` to dynamically expose installed grep/find/search-like tools while keeping the concrete base allowlist portable. The built-in advisory workflows use `tools: ["read", "bash", "grep", "find", "ls"]` plus `toolHints: ["search"]`.

Subagents receive no skills by default. Opt in per agent with `skills: ["skill-name"]`; if `tools` is also restricted, the engine automatically keeps `read` available so the subagent can load the selected `SKILL.md`. When `skills` is omitted, clear prompt text such as `/skill:name`, `include skill name`, or `use the name skill` is also treated as an opt-in. Pass `skills: []` to suppress that inference.

Set `model` only when a subagent should use a specific model. Bare ids keep the Anthropic shorthand; `provider/id` targets built-in, custom, or local providers. Omitted models inherit the host/session default; malformed or unknown explicit refs fail fast.

### Mutating agents in worktrees

Use `isolation: "worktree"` only for agents that should edit files. The agent runs in a detached git worktree, the engine captures its net patch, then the worktree is removed. The user's working tree is not changed.

```ts
const edit = await agent("Rename this helper and update its call sites.", {
  tools: ["read", "bash", "edit", "grep", "find", "ls"],
  isolation: "worktree",
  thinkingLevel: "medium",
});

if (edit.changed) {
  return { summary: "Patch ready for review.", patch: edit.patch };
}
return { summary: edit.result };
```

Isolated agents require the workflow `cwd` to be inside a git work tree. Outside git, the agent fails fast rather than silently mutating the shared directory. The return value is `{ result, patch, changed }`, where `result` is the normal text or structured `agent()` result and `patch` is a `git diff HEAD` patch. Worktree setup costs disk and git process time, so keep it opt-in for mutating/parallel-edit stages.

### Compose workflows

`workflow(ref, args?)` runs a registered workflow by name as a sub-step, returning its result. The child shares the parent run's concurrency cap, abort signal, and perf timing, and its phases nest under `<name> ▸ <phase>` in the live UI.

```ts
export default async function run({ workflow }: WorkflowApi) {
  const review = await workflow("code-review", "HEAD~3");
  return { review };
}
```

Nesting is one level only: calling `workflow()` from inside a sub-workflow rejects. Resolution throws on an unknown name. Inside `parallel()` or `pipeline()`, recoverable branch errors become `null` results, so filter nulls before synthesis; a genuine run abort still rejects.

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
- add `skills: ["skill-name"]` per `agent()` call when a subagent should use a pi skill; no skills are exposed by default;
- no extra exports or code after the default export.

Inline workflows run in-process with extension permissions, so treat them as trusted task automation.

## Runtime knobs

Only tune these when a workflow is too slow, too expensive, or too noisy:

| Knob | Meaning |
| --- | --- |
| `--concurrency=N` / `PI_WORKFLOW_CONCURRENCY=N` | Cap concurrent subagents. Default is `min(8, max(2, CPU count))`. |
| `--parallel-limit=N` / `PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT=N` | Limit eager `parallel()` submission. |
| `--budget=N` / `PI_WORKFLOW_BUDGET=N` | Set an output-token ceiling for completed subagents. `agent()` throws `WorkflowBudgetExceededError` before starting another agent once the ceiling is reached; agents already running may overshoot because the engine does not reserve per-agent estimates. |
| `--perf` / `PI_WORKFLOW_PERF=1` | Include internal timing aggregates. Usage/cost totals are reported separately from perf. |
| `PI_WORKFLOW_LANE_ITEM_LIMIT=N` | Cap retained progress lane items. |

## Common fixes

- **Unknown workflow**: confirm the extension is loaded with `pi list`; use `--refresh` for new drop-ins.
- **Inline compile error**: check the inline rules above.
- **Slow run**: lower fan-out, set `thinkingLevel`, or reduce `--concurrency`.
- **Budget exhausted**: narrow the target, raise `--budget`, reduce fan-out/concurrency, or guard custom loops with `api.budget.remaining()`.
- **Duplicate command/tool warnings while developing**: avoid loading both the global package and the working copy.
