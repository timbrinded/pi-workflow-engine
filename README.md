![agents](assets/preview.png)

# pi-workflow-engine

Programmable multi-agent workflows for the [pi](https://pi.dev) coding agent.

This is not just a way to run a prompt. It is a way to turn an agentic procedure into code: scope the task, fork isolated subagents, fan out across review lenses, validate every handoff with schemas, verify candidate findings, and synthesize one ranked result.

The built-in workflows are advisory: they inspect, fan out, verify, and report. They do not edit files. Start with `/workflow code-review`, or use the focused scouts for refactors, diagnosis, and performance.

## Why workflows matter

The best agentic coding work is rarely a single chat turn. It is a repeatable loop of context gathering, delegated investigation, structured handoffs, verification, and synthesis.

`pi-workflow-engine` brings that shape to pi with static TypeScript workflows:

- **Procedures, not prompts**: write the workflow once, then invoke it with `/workflow` or let the host agent call the `workflow` tool.
- **Isolated subagents**: each `agent()` runs in its own in-memory pi session, so exploratory work does not pollute the main conversation.
- **Parallel cognition**: run many focused agents at once, with a shared concurrency cap so large workflows stay bounded.
- **Typed handoffs**: pass structured data between stages using typebox schemas instead of asking the model to emit parseable prose.
- **Verifier stages**: make verification part of the control flow, not an optional final instruction.
- **Live progress**: surface phases, agent status, counters, and lane items in the TUI while the run is still moving.

The result is closer to an executable review playbook than a chatbot shortcut.

## Install

```bash
pi install git:github.com/timbrinded/pi-workflow-engine
```

Or from npm:

```bash
pi install npm:pi-workflow-engine
```

That's all. pi fetches the package and serves its core dependencies from its own bundle, so there is no clone, install, or build step. The package entrypoint is the canonical pi extension module at `.pi/extensions/pi-workflow-engine/index.ts`. Restart pi, or run `/reload` in an open session, then confirm it is registered:

```bash
pi list
```

Scope it to a single repo instead of globally. This writes to that repo's `.pi/settings.json`:

```bash
pi install git:github.com/timbrinded/pi-workflow-engine -l
```

Uninstall with:

```bash
pi remove git:github.com/timbrinded/pi-workflow-engine
```

## Usage

For the complete installation, invocation, authoring, tuning, and troubleshooting guide, see [USAGE.md](USAGE.md).

In a pi session, from inside a git repo with changes:

```text
/workflow code-review            # review the current branch or open PR
/workflow code-review HEAD~3     # review a ref range, target, or focus area
/workflow refactor-scout src/    # find safe refactor opportunities
/workflow diagnose "typecheck fails after the schema change"
/workflow perf-review "workflow startup latency"
/workflow code-review --inspect  # open the live workflow inspector
```

The host agent can also invoke the `workflow` tool mid-conversation. It accepts either a registered workflow `name` or a one-off inline workflow `script`:

```text
Run the code-review workflow on this PR and use the result before deciding what to fix.
```

Opt into dynamic multi-agent orchestration with the literal `dynamax` token, or keep it sticky for the session:

```text
dynamax inspect this bug with multiple focused agents
/dynamax on
/dynamax status
/dynamax off
```

`dynamax` is a permission signal for the host agent: once opted in, it may run an existing named workflow or author an inline workflow script through the `workflow` tool.

The advisory workflows inspect and report only; they do not edit files. They return the same shape: summary, ranked findings, evidence, impact, recommendations, and next steps.

## Built-in workflows

- `code-review`: Reviews the current branch, open PR, ref range, or target. It looks for correctness bugs and cleanup issues, then independently verifies candidates before ranking them.
- `refactor-scout`: Looks for small, safe refactor opportunities: duplication, complexity, weak types, boundary leaks, dead code, and convention drift.
- `diagnose`: Investigates a symptom, failing command, or regression. It generates competing root-cause hypotheses, verifies them, and returns the most likely causes with next validation steps.
- `perf-review`: Reviews a slow path or workload for bottleneck hypotheses, measurement gaps, and safe optimization directions. It avoids claiming certainty when measurement evidence is missing.

## The code-review workflow

The bundled review workflow is deliberately shaped like a serious review process:

1. **Scope**: detect the open PR or branch diff, list changed files, and read relevant project conventions.
2. **Find**: fan out across focused review lenses such as logic bugs, error paths, edge cases, simplification, and conventions.
3. **Gate and dedupe**: bound candidates to changed lines and collapse duplicate findings before spending verifier tokens.
4. **Verify**: send each survivor to an independent verifier that must confirm, mark plausible, or refute with evidence.
5. **Synthesize**: produce one ranked report with stats, verdicts, and concrete locations.

The review lenses live in `.pi/extensions/pi-workflow-engine/workflows/code-review.ts`. That is where your repo's real failure modes belong.

## Authoring workflows

A workflow is a TypeScript module that exports `meta` plus a default `async (api) => result`. The injected `api` gives you the primitives:

| Primitive | Behaviour |
|-----------|-----------|
| `agent(prompt, { schema })` | Runs a subagent in an isolated session. With a typebox `schema`, returns validated structured data; otherwise returns final text. |
| `parallel(thunks)` | Runs every thunk concurrently and waits for all results. |
| `pipeline(items, ...stages)` | Runs each item through all stages independently, with no barrier between stages. |
| `phase(title)` / `log(msg)` | Drives the live progress tree shown in the TUI and stderr breadcrumbs when headless. |
| `progress(event)` | Emits structured progress for richer workflow UI surfaces. |

```ts
import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "my-workflow",
  description: "Find, verify, and summarize something important.",
};

const FindingSchema = Type.Object({
  summary: Type.String(),
  file: Type.String(),
  line: Type.Optional(Type.Number()),
});

export default async function run({ agent, parallel, phase }: WorkflowApi) {
  phase("Find");

  const findings = await parallel([
    () => agent("Find correctness bugs in the diff.", { schema: FindingSchema, thinkingLevel: "low" }),
    () => agent("Find error-handling bugs in the diff.", { schema: FindingSchema, thinkingLevel: "low" }),
  ]);

  phase("Synthesize");
  return agent(`Summarize these findings: ${JSON.stringify(findings)}`, { thinkingLevel: "medium" });
}
```

Inline workflow scripts use the same primitives, but are passed as a string to the `workflow` tool instead of being saved as files. A minimal inline workflow starts with `export const meta` and uses the injected Type object for schemas:

```ts
export const meta = {
  name: "inline-review",
  description: "One-off focused review workflow.",
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

Inline v1 rules: no imports, no dynamic `import()`, pure-literal `meta`, schemas must use the injected Type value, and scripts run in-process with the extension's permissions. This v1 path is permissive rather than sandboxed.

Under the hood:

- **Each `agent()` is an in-process pi `AgentSession`** using `createAgentSession` and `SessionManager.inMemory()`.
- **Structured output is a terminating tool**. The engine registers one tool whose `parameters` is your schema; pi validates the call and the engine captures the args. There is no JSON scraping.
- **A single global semaphore caps concurrent agents**, so `parallel` and `pipeline` can nest freely while every `agent()` call still respects the run cap.
- **Three surfaces are registered**: `/workflow <name> [args]` for direct use, `/dynamax on|off|status` for sticky orchestration opt-in, and a `workflow` tool for host-agent delegation by `name` or inline `script`.

## Local development

Only needed if you want to add workflows, customise workflows, or contribute. Using the bundled workflows requires none of this.

```bash
git clone https://github.com/timbrinded/pi-workflow-engine
cd pi-workflow-engine
bun install
bun run typecheck
bun run test
```

The test suite is no-LLM and uses Bun's built-in `bun test` runner, not a third-party test framework.

### Performance controls and benchmarks

The workflow engine is measurement-first: tune only after checking queue wait, local orchestration, discovery, and UI render costs on the machine where you run pi.

Runtime controls:

- `PI_WORKFLOW_PERF=1` enables the internal per-run performance recorder used by the orchestration instrumentation.
- `PI_WORKFLOW_CONCURRENCY=N` sets the per-run agent semaphore cap. The default remains `min(8, max(2, CPU count))`.
- `PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT=N` limits how many `parallel()` thunks are submitted at once; this is separate from the running-agent semaphore cap.
- `PI_WORKFLOW_LANE_ITEM_LIMIT=N` caps retained progress lane items per lane; snapshots report how many older items are hidden.
- Slash commands can override selected controls per run: `/workflow <name> --concurrency=N --parallel-limit=N ...`.

No-LLM benchmark scripts:

```bash
bun run bench:concurrency -- --items 200 --concurrency 8 --json
bun run bench:discovery -- --iterations 3 --json
bun run bench:startup -- --json
bun run bench:ui -- --agents 1000 --lane-items 1000 --json
```

Add `--out` to write machine-local JSON under `.artifacts/benchmarks/`. These timings are advisory, not portable thresholds.

Guardrails:

- Do not pool or reuse subagent sessions until `agent.create_session_ms` is proven material and isolation semantics are reviewed.
- Do not lazy-load guaranteed built-in workflow modules until pi/jiti bundled `typebox` identity is proven for that path.
- Do not raise the default concurrency without queue-wait versus run-time evidence.

Load your working copy through the package manifest without installing it. This is ephemeral and exercises the same `.pi/extensions/pi-workflow-engine/index.ts` entrypoint that installed packages use:

```bash
pi -e .
```

This repo also includes `.pi/settings.json` for project-local auto-discovery. If you also have the global package installed, pi may report duplicate `/workflow` or `workflow` tool diagnostics; remove one source or force pi to ignore discovered extensions and load this working copy instead:

```bash
pi -ne -e .
```

Add a built-in workflow by creating `.pi/extensions/pi-workflow-engine/workflows/<name>.ts`, importing it in `.pi/extensions/pi-workflow-engine/src/workflows.ts`, and adding it to `BUILTIN_WORKFLOWS`. Statically imported workflows share pi's bundled `typebox`, which guarantees schema validation. Files in `.pi/extensions/pi-workflow-engine/workflows/` and `~/.pi/agent/workflows/` are also discovered dynamically at runtime on a best-effort basis.

Keep guaranteed built-ins statically imported. Optimize cold startup at the extension entrypoint or discovery boundary first; do not lazy-load built-in workflow modules unless a test proves pi/jiti preserves the same bundled `typebox` identity for dynamically imported built-ins.

Tune the built-in review workflow by editing the `ANGLES` array in `.pi/extensions/pi-workflow-engine/workflows/code-review.ts`. Tune `model`, `thinkingLevel`, and `tools` per `agent()` call, and use `PI_WORKFLOW_CONCURRENCY` or `/workflow <name> --concurrency=N` for measured per-run concurrency experiments.

### Layout

```text
.pi/
  settings.json                         project-local pi resource settings
  extensions/pi-workflow-engine/
    index.ts                            canonical extension entry; registers the command and tool
    src/
      types.ts                          WorkflowApi / WorkflowModule contracts
      agent-runner.ts                   createAgentSession + terminating-tool schema bridge
      concurrency.ts                    Semaphore, parallel(), pipeline()
      engine.ts                         runWorkflow(); binds primitives to one run
      progress.ts                       live phase/agent tree via ctx.ui.setWidget
      discovery.ts                      static registry + best-effort drop-in loading
      workflows.ts                      statically registered built-in workflows
    workflows/
      code-review.ts                    scope -> find -> verify -> synthesize
      refactor-scout.ts                 advisory refactor opportunities
      diagnose.ts                       advisory bug diagnosis
      perf-review.ts                    advisory performance investigation
```

## License

MIT. See [LICENSE](LICENSE).
