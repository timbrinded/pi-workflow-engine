![agents](assets/preview.png)

# pi-workflow-engine

Claude Code style workflows for the [pi](https://pi.dev) coding agent.

This is not just a way to run a prompt. It is a way to turn an agentic procedure into code: scope the task, fork isolated subagents, fan out across review lenses, validate every handoff with schemas, verify candidate findings, and synthesize one ranked result.

The built-in workflows are advisory: they inspect, fan out, verify, and report. They do not edit files. Start with `/workflow code-review`, or use the focused scouts for refactors, diagnosis, and performance.

## Why workflows matter

Claude Code popularised a useful pattern: the best agentic coding work is not a single chat turn. It is a loop of context gathering, delegated action, verification, and synthesis. Its docs describe the [agentic loop](https://code.claude.com/docs/en/glossary#agentic-loop), [skills and commands](https://code.claude.com/docs/en/skills), and [subagents](https://code.claude.com/docs/en/glossary#subagent) as composable building blocks for repeatable engineering work.

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

That's all. pi fetches the package and serves its core dependencies from its own bundle, so there is no clone, install, or build step. Restart pi, or run `/reload` in an open session, then confirm it is registered:

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

In a pi session, from inside a git repo with changes:

```text
/workflow code-review            # review the current branch or open PR
/workflow code-review HEAD~3     # review a ref range, target, or focus area
/workflow refactor-scout src/    # find safe refactor opportunities
/workflow diagnose "typecheck fails after the schema change"
/workflow perf-review "workflow startup latency"
/workflow code-review --inspect  # open the live workflow inspector
/workflow ping                   # quick engine smoke test
```

The host agent can also invoke the `workflow` tool mid-conversation:

```text
Run the code-review workflow on this PR and use the result before deciding what to fix.
```

The advisory workflows inspect and report only; they do not edit files. They return the same shape: summary, ranked findings, evidence, impact, recommendations, and next steps.

## Built-in workflows

- `code-review`: Reviews the current branch, open PR, ref range, or target. It looks for correctness bugs and cleanup issues, then independently verifies candidates before ranking them.
- `refactor-scout`: Looks for small, safe refactor opportunities: duplication, complexity, weak types, boundary leaks, dead code, and convention drift.
- `diagnose`: Investigates a symptom, failing command, or regression. It generates competing root-cause hypotheses, verifies them, and returns the most likely causes with next validation steps.
- `perf-review`: Reviews a slow path or workload for bottleneck hypotheses, measurement gaps, and safe optimization directions. It avoids claiming certainty when measurement evidence is missing.
- `ping`: Minimal smoke workflow for checking that the engine can run one structured agent call.

## The code-review workflow

The bundled review workflow is deliberately shaped like a serious review process:

1. **Scope**: detect the open PR or branch diff, list changed files, and read relevant project conventions.
2. **Find**: fan out across focused review lenses such as logic bugs, error paths, edge cases, simplification, and conventions.
3. **Gate and dedupe**: bound candidates to changed lines and collapse duplicate findings before spending verifier tokens.
4. **Verify**: send each survivor to an independent verifier that must confirm, mark plausible, or refute with evidence.
5. **Synthesize**: produce one ranked report with stats, verdicts, and concrete locations.

The review lenses live in `workflows/code-review.ts`. That is where your repo's real failure modes belong.

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

Under the hood:

- **Each `agent()` is an in-process pi `AgentSession`** using `createAgentSession` and `SessionManager.inMemory()`.
- **Structured output is a terminating tool**. The engine registers one tool whose `parameters` is your schema; pi validates the call and the engine captures the args. There is no JSON scraping.
- **A single global semaphore caps concurrent agents**, so `parallel` and `pipeline` can nest freely while every `agent()` call still respects the run cap.
- **Two surfaces are registered**: `/workflow <name> [args]` for direct use, and a `workflow` tool for host-agent delegation.

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

Load your working copy into a session without installing it. This is ephemeral and overrides nothing:

```bash
pi -e ./src/index.ts -p "/workflow ping"
```

Add a workflow by creating `workflows/<name>.ts`, importing it in `src/workflows.ts`, and adding it to `BUILTIN_WORKFLOWS`. Statically imported workflows share pi's bundled `typebox`, which guarantees schema validation. Files in `workflows/` and `~/.pi/agent/workflows/` are also discovered dynamically at runtime on a best-effort basis.

Tune the built-in review workflow by editing the `ANGLES` array in `workflows/code-review.ts`. Tune `model`, `thinkingLevel`, and `tools` per `agent()` call, and tune `DEFAULT_CONCURRENCY` in `src/engine.ts`.

### Layout

```text
src/
  index.ts         extension entry; registers the command and tool
  types.ts         WorkflowApi / WorkflowModule contracts
  agent-runner.ts  createAgentSession + terminating-tool schema bridge
  concurrency.ts   Semaphore, parallel(), pipeline()
  engine.ts        runWorkflow(); binds primitives to one run
  progress.ts      live phase/agent tree via ctx.ui.setWidget
  discovery.ts     static registry + best-effort drop-in loading
workflows/
  code-review.ts     scope -> find -> verify -> synthesize
  refactor-scout.ts  advisory refactor opportunities
  diagnose.ts        advisory bug diagnosis
  perf-review.ts     advisory performance investigation
  ping.ts            minimal smoke workflow
```

## License

MIT. See [LICENSE](LICENSE).
