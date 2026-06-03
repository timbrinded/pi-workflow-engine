# pi-workflow-engine

A customisable multi-agent workflow-orchestration engine for the [pi](https://pi.dev) coding agent — your own version of Claude Code's built-in `/code-review` workflow, built on pi's SDK.

A **workflow** is a TypeScript file that orchestrates subagents with five primitives:

```ts
import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = { name: "my-workflow", description: "..." };

export default async function run({ agent, parallel, pipeline, phase, log, args }: WorkflowApi) {
  phase("Find");
  const result = await agent("find issues...", { schema: Type.Object({ /* ... */ }) }); // → validated object
  // parallel(thunks) — barrier; pipeline(items, ...stages) — no barrier between stages
  return result;
}
```

| Primitive | Behaviour |
|-----------|-----------|
| `agent(prompt, { schema })` | Runs a subagent in an isolated session; with `schema` (typebox) it returns validated structured data, else final text. |
| `parallel(thunks)` | Runs all thunks concurrently and waits for every result (barrier). |
| `pipeline(items, ...stages)` | Runs each item through all stages independently — no barrier between stages. |
| `phase(title)` / `log(msg)` | Drive the live progress tree shown in the TUI. |

A single global semaphore caps concurrent agents, so structure is free to nest.

## How it works

- Each `agent()` is an in-process pi `AgentSession` (`createAgentSession` + `SessionManager.inMemory()`).
- **Structured output** is a terminating tool: the engine registers one tool whose `parameters` *is* your schema; pi validates the args and the engine captures them — no event parsing.
- Surfaces: a `/workflow <name> [args]` command and a `workflow` tool the host agent can call.

## Install / register

```bash
cd ~/pi-workflow-engine
bun install            # devDeps for typechecking only; pi serves bundled copies at runtime
bun run typecheck
```

Point pi at the repo by adding it to `~/.pi/agent/settings.json`:

```json
{ "packages": ["~/pi-workflow-engine"] }
```

(or symlink it: `ln -s ~/pi-workflow-engine ~/.pi/agent/extensions/workflow-engine`). Then `/reload` in pi or restart.

## Use

```
/workflow code-review                 # review the current branch
/workflow code-review HEAD~3           # review a ref range / target
```

## Add a workflow

Drop a `.ts` in `workflows/`. To guarantee it loads with pi's bundled `typebox`, also import it in `src/workflows.ts` and add it to `BUILTIN_WORKFLOWS`. (Files in `workflows/` and `~/.pi/agent/workflows/` are also discovered dynamically at runtime, best-effort.)

## Layout

```
src/
  index.ts         extension entry (registers command + tool)
  types.ts         WorkflowApi / WorkflowModule contracts
  agent-runner.ts  the createAgentSession + terminating-tool schema bridge
  concurrency.ts   Semaphore, parallel(), pipeline()
  engine.ts        runWorkflow() — binds primitives to a run
  progress.ts      live phase/agent tree via ctx.ui.setWidget
  discovery.ts     static registry + best-effort drop-in loading
workflows/
  code-review.ts   the example: scope → find → verify → synthesize
```
