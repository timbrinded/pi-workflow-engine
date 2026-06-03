# pi-workflow-engine

A customisable multi-agent workflow-orchestration engine for the [pi](https://pi.dev) coding agent — your own version of Claude Code's built-in `/code-review`, built on pi's SDK. Workflows fan out to many subagents, pass validated structured data between stages, and synthesise a result.

## Install

```bash
pi install git:github.com/timbrinded/pi-workflow-engine
```

That's all — pi fetches the package and serves its dependencies from its own bundle, so there's no clone, install, or build step. Restart pi (or run `/reload` in an open session), then confirm it's registered:

```bash
pi list
```

Scope it to a single repo instead of globally (writes to that repo's `.pi/settings.json`):

```bash
pi install git:github.com/timbrinded/pi-workflow-engine -l
```

Uninstall with `pi remove git:github.com/timbrinded/pi-workflow-engine`.

## Usage

In a pi session, from inside a git repo with changes:

```
/workflow code-review            # review the current branch
/workflow code-review HEAD~3     # review a ref range / target / focus area
/workflow ping                   # quick engine smoke test (one agent)
```

The host agent can also invoke the `workflow` tool itself mid-conversation (e.g. "run the code-review workflow") and fold the structured result back into its reasoning.

`code-review` returns a verified, ranked report:

```json
{
  "summary": "1 confirmed bug: off-by-one loop boundary in sum.js ...",
  "findings": [
    {
      "file": "sum.js",
      "line": 3,
      "severity": "bug",
      "verdict": "CONFIRMED",
      "summary": "Off-by-one: `i <= arr.length` should be `i < arr.length`; accesses arr[arr.length] (undefined) → NaN."
    }
  ]
}
```

## How it works

A **workflow** is a TypeScript module that exports `meta` plus a default `async (api) => result`. The injected `api` gives you five primitives:

| Primitive | Behaviour |
|-----------|-----------|
| `agent(prompt, { schema })` | Runs a subagent in an isolated session; with a typebox `schema` it returns validated structured data, otherwise the final text. |
| `parallel(thunks)` | Runs every thunk concurrently and waits for all (a barrier). |
| `pipeline(items, ...stages)` | Runs each item through all stages independently — no barrier between stages. |
| `phase(title)` / `log(msg)` | Drive the live progress tree shown in the TUI. |

```ts
import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = { name: "my-workflow", description: "..." };

export default async function run({ agent, parallel, pipeline, phase, log, args }: WorkflowApi) {
  phase("Find");
  const result = await agent("find issues ...", { schema: Type.Object({ /* ... */ }) });
  return result; // a typed object, validated against the schema
}
```

Under the hood:

- **Each `agent()` is an in-process pi `AgentSession`** (`createAgentSession` + `SessionManager.inMemory()`), inheriting the host's model unless you set one.
- **Structured output is a terminating tool**: the engine registers one tool whose `parameters` *is* your schema; pi validates the call and the engine captures the args — no parsing.
- **A single global semaphore caps concurrent agents**, so `parallel`/`pipeline` nest freely while the cap holds inside every `agent()` call.
- **Surfaces**: a `/workflow <name> [args]` command, plus a `workflow` tool the host agent can call.

## Local development

Only needed if you want to **add or customise workflows, or contribute** — using the bundled workflows requires none of this.

```bash
git clone https://github.com/timbrinded/pi-workflow-engine
cd pi-workflow-engine
bun install            # dev deps for typechecking only; pi serves bundled copies at runtime
bun run typecheck      # tsc --noEmit
bun scripts/smoke.ts   # no-LLM check: module graph loads + workflow discovery resolves
```

Load your working copy into a session without installing it (ephemeral — overrides nothing):

```bash
pi -e ./src/index.ts -p "/workflow ping"
```

**Add a workflow:** drop a `.ts` in `workflows/`, import it in `src/workflows.ts`, and add it to `BUILTIN_WORKFLOWS`. Statically-imported workflows share pi's bundled `typebox`, which guarantees schema validation. (Files in `workflows/` and `~/.pi/agent/workflows/` are also discovered dynamically at runtime, best-effort.)

**Customise the review:** edit the `ANGLES` array in `workflows/code-review.ts` — the lenses are where your codebase's real failure modes and conventions belong. Tune `model` / `thinkingLevel` / `tools` per `agent()` call, and `DEFAULT_CONCURRENCY` in `src/engine.ts`.

### Layout

```
src/
  index.ts         extension entry (registers the command + tool)
  types.ts         WorkflowApi / WorkflowModule contracts
  agent-runner.ts  the createAgentSession + terminating-tool schema bridge
  concurrency.ts   Semaphore, parallel(), pipeline()
  engine.ts        runWorkflow() — binds the primitives to a run
  progress.ts      live phase/agent tree via ctx.ui.setWidget
  discovery.ts     static registry + best-effort drop-in loading
workflows/
  code-review.ts   the example: scope → find → verify → synthesize
  ping.ts          minimal smoke workflow
```
