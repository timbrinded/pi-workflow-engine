# pi-workflow-engine

[![CI](https://github.com/timbrinded/pi-workflow-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/timbrinded/pi-workflow-engine/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-workflow-engine)](https://www.npmjs.com/package/pi-workflow-engine)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A multi-agent workflow engine for [pi](https://pi.dev).**

One coding agent is usually enough. When a task needs independent opinions,
competing hypotheses, or a verifier that did not write the first answer, this
extension lets pi fan the work out and bring the evidence back together.

The process is simple: **scope → fan out → verify → synthesize**. You see the work
live in the TUI, concurrency stays bounded, and the final answer includes the
subagents' combined usage and estimated cost when the provider exposes enough
data to calculate them.

![A lead agent coordinating subagents](assets/preview.png)

## Quick start

```bash
pi install npm:pi-workflow-engine
```

Restart pi or run `/reload`, then add `dynamax` to a prompt:

```text
dynamax investigate why typecheck started failing on this branch
```

`dynamax` is a one-shot opt-in. It lets the host agent choose a saved workflow
or author a temporary one for this task. Use `/workflow:dynamax on` when you
want that permission to remain active for the session.

Saved workflows are available directly:

```text
/workflow code-review
/workflow refactor-scout src/
/workflow diagnose "the schema migration broke typecheck"
/workflow perf-review "workflow startup latency"
```

The package uses pi's bundled SDK and core packages; it does not install or
bundle a second agent runtime.

## What it gives you

- **Independent passes.** Different agents can inspect correctness, tests,
  coupling, performance, or any lenses you define.
- **Typed handoffs.** A TypeBox schema becomes the agent's terminating tool
  contract—there is no JSON scraping.
- **Live progress.** Phases, agents, findings, and logs are visible in the TUI,
  alongside usage and estimated cost when provider data is available.
- **Bounded execution.** One semaphore covers nested fan-out, pipelines, and
  sub-workflows; every run also caps live model-call starts and each call's duration.
- **Evidence before action.** Built-in workflows inspect and report by default;
  they do not edit your working tree.
- **Reviewable mutation.** An author can opt a mutating agent into a disposable
  git worktree and receive its patch.
- **Safe replay.** Interrupted runs reuse a completed call only when every
  captured observable surface and its effective execution identity still match.

## Built-in workflows

| Workflow | Best used for |
| --- | --- |
| `code-review` | PRs, branch diffs, ref ranges, or focused targets |
| `refactor-scout` | Small, defensible refactors without broad rewrites |
| `diagnose` | Competing explanations for bugs or failing commands |
| `perf-review` | Measured bottlenecks versus performance guesses |

These are starting points, not a fixed menu. Dynamax can author a one-off
workflow when the question needs different lenses or an adaptive second pass.

## The review experience

When reviewing a PR, `code-review` uses its cumulative diff, so superseded code
from earlier commits does not become a finding. Candidate issues are
independently verified, deduplicated, and ranked before synthesis.

Add `--result-viewer` to open the interactive findings view. It exposes a findings list for follow-up. Reopen the current session's latest review
with `/workflow:results` or `ctrl+shift+r`—it does not rerun the workflow.

The **Fix** action creates one disposable worktree per selected finding and
returns separate patch previews without touching the active checkout. GitHub
comments are available only for a verified PR target; the engine checks the
snapshot and PR head again and skips exact duplicates before posting.

## Prompts that benefit from Dynamax

- **Review:** `dynamax` review this branch from correctness, test,
  security-boundary, and maintainability angles; verify every finding.
- **Debug:** `dynamax` investigate this flaky test using separate hypotheses for
  timing, fixtures, recent diffs, and external state.
- **Decide:** `dynamax` argue both implementation options, then have another
  agent attack the recommendation.
- **Refactor:** `dynamax` find the smallest safe path through this module and
  identify what should not change.

Tiny edits and straightforward questions are still better handled by one agent.
Dynamax earns its cost when independence or breadth changes the answer.

## Write a workflow

A saved workflow is a TypeScript module with metadata and one async function.
The injected API supplies agents, concurrency primitives, phases, progress,
budgets, cancellation, and sub-workflow composition.

```ts
import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "two-angle-review",
  description: "Find issues independently, then synthesize.",
};

const Finding = Type.Object({
  summary: Type.String(),
  evidence: Type.Array(Type.String()),
});
const reviewTools = ["read", "grep", "find", "ls"];

export default async function run(
  { agent, parallel, phase, args }: WorkflowApi,
) {
  phase("Find");
  const findings = await parallel([
    () => agent(`Review correctness: ${args}`, {
      schema: Finding,
      tools: reviewTools,
      thinkingLevel: "low",
      resume: "read-only",
    }),
    () => agent(`Review edge cases: ${args}`, {
      schema: Finding,
      tools: reviewTools,
      thinkingLevel: "low",
      resume: "read-only",
    }),
  ]);

  phase("Synthesize");
  return agent(`Merge and rank these findings: ${JSON.stringify(findings)}`, {
    tools: [],
    thinkingLevel: "medium",
    resume: "read-only",
  });
}
```

Set `thinkingLevel` on fan-out agents so they do not all inherit an expensive
global setting. The [usage guide](USAGE.md#author-a-saved-workflow) covers
schemas, tools, skills, pipelines, settled results, worktree isolation, inline
workflows, and registration.

## Design choices

- **Agent sessions:** each call uses an in-process pi `AgentSession` with an
  in-memory session manager.
- **Structured output:** the schema is a terminating tool definition validated
  by pi.
- **Recoverable failures:** a failed parallel branch becomes `null`; surviving
  work continues.
- **Fatal failures:** cancellation aborts siblings and drains submitted work
  before rejection.
- **Run limits:** concurrency bounds simultaneous live agents; the total-agent
  limit bounds live model-call starts across parent and child workflows and
  excludes replay hits; the per-agent timeout aborts stalled live sessions.
- **Mutating agents:** disposable worktrees isolate edits and return
  baseline-relative patches.
- **Resume:** journals bind workspace-aware calls to repository state and all
  calls to workflow, model, prompt, skill, and tool identity.
- **Dependencies:** pi and TypeBox remain host-provided peers; the package ships
  no duplicate runtime stack.

The replay contract deliberately fails closed. For workspace-aware calls,
changed commits, dirty state, and declared ignored inputs invalidate a hit.
Workflow source, effective model or prompt, selected skills, and executable
tools remain part of the relevant identity; unsafe or unbounded surfaces run
live instead.

## Develop locally

```bash
git clone https://github.com/timbrinded/pi-workflow-engine
cd pi-workflow-engine
bun install
bun run typecheck && bun run test
pi -ne -e .
```

`pi -ne -e .` loads the working copy without also loading an installed global
copy. There is no build step; pi loads the TypeScript extension directly.

For the complete command reference, runtime controls, authoring rules, and
troubleshooting, see [USAGE.md](USAGE.md). The public API lives in
[types.ts](.pi/extensions/pi-workflow-engine/src/types.ts), and the built-in
[code-review workflow](.pi/extensions/pi-workflow-engine/workflows/code-review.ts)
is the most complete example.

Questions and ideas are welcome in
[GitHub Issues](https://github.com/timbrinded/pi-workflow-engine/issues).
MIT licensed.
