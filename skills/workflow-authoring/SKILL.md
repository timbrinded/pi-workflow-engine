---
name: workflow-authoring
description: "Reference for writing pi-workflow-engine workflow scripts: the inline script contract, the injected api (agent, parallel, pipeline, classify, budget, workflow), quality patterns, resume, and saving a reusable workflow. Read before writing or editing an inline script for the workflow tool. It does not itself authorize running a workflow."
---

# Writing workflow scripts

Read this before you write or edit a script for the `workflow` tool. It does not grant permission to run one: call the tool only when the user opted in (the `dynamax` token, sticky `/workflow:dynamax`, an explicit request to run or author a workflow, or a command or skill instruction).

A workflow is plain code that fans work out to subagents, passes validated data between stages, and returns one result. Prefer a registered workflow (`name`) when one fits; write a `script` when none does.

## Script contract

```js
export const meta = {
  name: "auth-audit",
  description: "Audit the auth middleware for bypasses.",
  phases: [{ title: "Find" }, { title: "Verify" }],
};

export default async function run(api) {
  const Finding = Type.Object({ file: Type.String(), summary: Type.String() });
  const findings = await api.agent(`Find auth bypasses in ${api.args || "src/"}`, {
    label: "find", phase: "Find", profile: "small", schema: Type.Object({ items: Type.Array(Finding, { maxItems: 20 }) }),
  });
  return { summary: `${findings.items.length} candidate bypasses`, findings: findings.items };
}
```

- The script is plain JavaScript compiled in-process: no TypeScript annotations, `as` casts, or interfaces.
- It must start with `export const meta = { ... };`, a pure literal: strings, numbers, booleans, `null`, arrays, and objects only. No variables, calls, template literals, spreads, computed keys, or raw newlines inside strings. `name` is required; `description`, `whenToUse` (the situation that should make a model pick it), and `phases` are optional. Each phase is `{ title, detail?, profile? }`.
- Exactly one `export default` follows the meta: an `async function` or `async (api) => { ... }` with a block body. Nothing may follow it but `;` and comments. Put helpers and constants inside the function body.
- No `import` statements, no dynamic `import()`, no other exports.
- `Type` (TypeBox) is an injected global: write `Type.Object(...)` directly. It is not a property of `api`. Using the injected `Type` keeps schemas on pi's bundled TypeBox, so validation works.
- The return value becomes the tool result. Return a string or an object with a short `summary` first; the result the host model sees is truncated when it is very large, so return conclusions, not raw transcripts.

## The api

| Member | What it does |
| --- | --- |
| `agent(prompt, opts?)` | Runs one subagent session. `prompt` must be a plain string (build it with a template string first). Without `schema` it resolves to the final assistant text, a string. With `schema` it resolves to an object already validated against the schema. |
| `parallel(thunks)` | Runs `() => Promise` thunks concurrently and waits for all. A recoverable failure becomes a `null` slot; the other slots keep their results. |
| `parallel(thunks, { settled: true })` | Same, but every slot is `{ ok: true, value }` or `{ ok: false, error: { name?, message, code?, details? } }`, in input order. |
| `pipeline(items, ...stages)` | Runs every item through all stages independently. Each stage is `(prev, item, index) => Promise`; the first stage receives the item as `prev`. A failed stage turns that item's slot into `null` and skips its later stages. |
| `classify(context, opts?)` | Answers typed `choice`/`score`/`bool` questions about JSON `state` with a classifier model and no chat session. |
| `workflow(name, args?)` | Runs a registered workflow inline and returns its result. One level of nesting only. |
| `phase(title)` / `log(message)` / `progress(event)` | Drive the live progress tree, logs, counters, and lanes. |
| `budget` | `{ total, spent(), remaining() }` in output tokens; `total` is `null` when the run has no budget. |
| `args`, `cwd`, `signal` | The raw argument string, the host working directory, and the run's abort signal. |

Agent options:

| Option | Meaning |
| --- | --- |
| `profile` | `"small"`, `"medium"`, or `"big"`: the user's central model routes. Set one on every agent. |
| `label`, `phase` | Row label and phase group in the progress tree. |
| `schema` | TypeBox schema; the agent must answer through a validated `final_answer` tool. Two repair attempts, then the call rejects with code `WORKFLOW_STRUCTURED_OUTPUT_NONCOMPLIANCE`. |
| `tools` | Strict allowlist of tool names, for example `["read", "bash", "grep", "find", "ls"]`. `[]` gives a tool-free agent. |
| `toolHints` | `["search"]` adds installed grep/find/code-search tools; `["external-search"]` adds web search, browsing, and URL-extraction tools. `requireToolHints: true` fails before prompting when a hint matched nothing. |
| `skills` | Pi skills to expose to this subagent; none by default. |
| `isolation: "worktree"` | Run in a disposable git worktree and return the patch (see below). |
| `model`, `thinkingLevel` | Intentional per-call overrides of the profile. `model` is `"provider/id"`. |
| `resume`, `resumeInputs`, `cacheKey` | Replay controls (see Resume). |

Add `"codemode"` to an agent's `tools` when it should batch or filter many tool calls in one script; those scripts can call only the agent's other allowed tools. Host MCP tools reach subagents only in synchronous `workflow` tool runs: name them in `tools` (for example `"mcp__linear__create_issue"`) or use `toolHints: ["external-search"]`. Background runs and `/workflow` commands cannot bridge them, and an agent that names one fails before prompting.

## Profiles, labels, and phases

- Set `profile` on every `agent()` call: `small` for scouting, finding, and verifying; `medium` for judgement and synthesis; `big` for the hardest reasoning. Use `model`/`thinkingLevel` only for a deliberate override.
- A phase declared as `{ title: "Verify", profile: "small" }` routes agents that pass `phase: "Verify"` and set neither `profile` nor `model`. Routing order: the agent's `model`, its `profile`, its phase's `profile`, then the host model.
- Inside `parallel` and `pipeline`, pass `phase` and `label` in each agent's options. The global `phase()` is one shared value that every concurrent branch reads and writes, so calling it inside fan-out branches races and misfiles rows. Call `phase()` only between sequential stages.

## Concurrency rules

**Use `api.parallel`, never `Promise.all` or `Promise.allSettled` over agents.** `api.parallel` turns a recoverable failure (schema exhaustion, an agent timeout, the budget or agent limit, a provider error) into a `null` slot and the survivors continue; `Promise.all` rejects the whole stage on the first failure and discards every sibling result. `api.parallel` also applies the run's submission limit and cancels siblings on a genuine abort. Filter the nulls before using the results:

```js
const found = (await api.parallel(lenses.map((lens) => () =>
  api.agent(`Review ${api.args} for ${lens}`, { label: `find:${lens}`, phase: "Find", profile: "small", schema: Findings }),
))).filter((result) => result !== null);
```

Use settled mode when the error detail matters, for example to report which branches failed and why instead of silently shrinking coverage.

**Default to `api.pipeline(items, ...stages)`.** With no barrier between stages, item A can be verified while item B is still being found, and the run's concurrency cap still bounds the number of live agents, so it is safe to start every item at once:

```js
const verified = await api.pipeline(
  files,
  (file) => api.agent(`Find defects in ${file}`, { label: `find:${file}`, phase: "Find", profile: "small", schema: Findings }),
  (found, file) => api.parallel(found.items.map((finding, i) => () =>
    api.agent(`Try to refute this finding in ${file}: ${JSON.stringify(finding)}`, {
      label: `verify:${file}:${i}`, phase: "Verify", profile: "small", schema: Verdict,
    }),
  )),
);
```

Barrier smell test: before writing `await api.parallel(...)` followed by another fan-out over its results, ask whether the next stage needs every result of the previous one. A barrier is justified only for cross-item dedupe or merge, an early exit on a zero count, or a stage that compares against all prior results. Flatten, map, or filter alone is not a reason: do it inside a pipeline stage.

Host-written scripts in practice reached for `Promise.all` and never for `pipeline`; both habits lose results or wall-clock time. Check every fan-out against these two rules.

## Quality patterns

- **Adversarial verify.** Give each finding to a separate verifier told to refute it, and keep only what survives. Thin evidence means not substantiated, not confirmed.
- **Perspective-diverse verify.** For findings that matter, use two or three verifiers with different methods (read the callers, reproduce it, check the tests) and require agreement.
- **Judge panel.** Generate several independent answers or designs, then have a judge (or several) pick or merge them against stated criteria.
- **Loop until dry.** Repeat discovery rounds, deduping each round against everything seen so far, not only the last round. Stop when a round adds nothing new, or at a round cap or budget guard.
- **Multi-modal sweep.** Cover the space from different angles (per file, per lens, per symptom, search-driven and reading-driven) and take the union.
- **Completeness critic.** After synthesis, have an agent check the result against the original request or work list and name the gaps; follow up only on material ones.
- **No silent caps.** Whenever you slice a list, cap rounds, or skip items, `api.log()` what was dropped and report it in the result, for example in a `gaps` or `skipped` field.
- **Adaptive multi-pass, only when needed.** A single-pass fan-out is the default when it can answer the question. When the first pass may expose gaps, conflicts, weak claims, or missing evidence: run the bounded first-pass agents; give their surviving results to a structured gap-analysis agent so the LLM decides what needs follow-up; put a hard `maxItems` bound on LLM-authored task arrays and defensively slice them before fan-out; use ordinary conditionals or bounded loops to launch follow-up agents only when gaps exist; synthesize the first-pass and follow-up results together. Do not generate a second pass when the first pass is sufficient, and do not invent iteration, quorum, graph, reduction, or retry primitives for this.

## Plan the run

- **Scout inline first, then orchestrate.** Use your own tools to find the work list (the files, failing tests, or findings) before writing the script, then fan out over that concrete list. Embed the list in the script or pass it through `args` (`JSON.stringify` it and `JSON.parse(api.args)` inside).
- **One single-phase workflow per turn.** For multi-phase work (understand, design, implement, review), run one workflow per phase and read each result before choosing the next, rather than one script that guesses every phase in advance.
- **Scale to the request and the size guideline.** A focused question needs a few agents, a broad sweep more. The `<workflows>` section's size guideline line (set by the user with `/workflow:size`) bounds each workflow unless the user asks for more. The run's `maxAgents` limit (default 64) is a separate hard backstop, not a target.
- **Use `classify()` as a cheap gate** between stages: dedupe, triage, or route items without a full agent. It rejects when no classifier model is configured, so call it inside `api.parallel` or a `try`/`catch` and fall back to an agent or to keeping the item. Results are not journaled, so a resumed run classifies again.

```js
const answers = await api.classify(
  { state: { finding }, questions: { real: { type: "bool", instructions: "Is this a real defect?", criteria: { true: "Concrete and reachable", false: "Speculative" } } } },
  { label: `triage:${finding.id}` },
);
const keep = answers.real?.type === "bool" ? answers.real.probability > 0.5 : true;
```

## Budget

`api.budget.total` is the output-token ceiling (`null` when unset); `spent()` and `remaining()` are live. Once the ceiling is reached `agent()` rejects with `WorkflowBudgetExceededError` (a `null` slot inside `parallel`); agents already running can overshoot. Scale fleets from `total`, and guard every loop with it so an unbudgeted run still terminates:

```js
const width = api.budget.total ? Math.max(2, Math.min(8, Math.floor(api.budget.total / 40_000))) : 4;
for (let round = 0; round < 5 && (api.budget.total === null || api.budget.remaining() > 30_000); round++) {
  // one discovery round
}
```

## Edits in worktrees

Give `isolation: "worktree"` only to agents that edit files. The agent runs in a disposable git worktree, and `agent()` resolves to `{ result, patch, changed, baselineOid }`: `result` is the usual text or schema object, `patch` is its `git diff`, `changed` says whether it touched anything. The user's checkout is never modified; return the patches so the host can review and apply them. It requires the workflow `cwd` to be inside a git work tree.

## Resume and diagnosis

- Every result names its run ID. Pass `resumeFromRunId: "<run id>"` to the tool to replay completed agent calls whose prompt, options, and execution identity still match; the rest run live.
- Shared-workspace agents replay only with `resume: "read-only"` (use it for advisory agents); isolated agents replay by default. `resume: "off"` forces a live call. Give repeated identical calls a distinct `cacheKey`, such as `` `verify:${finding.id}` ``.
- After editing the script, `resumeEditedWorkflow: true` (with `resumeFromRunId`) reuses calls that did not change. Use it only when the user accepts that.
- The journal at `.pi/.workflow-runs/<runId>.jsonl` holds one line per completed replayable agent call (`resume: "read-only"` or isolated) with its result; `<runId>.run.json` beside it holds the run state, compact progress, and final error. Read them before diagnosing an empty or unexpected result: a replayable call missing from the journal failed or never ran, while calls without a replay policy are never journaled.

## Run modes

- `background: true` only when the user wants the run to continue after this tool call; the tool returns a run ID and the result arrives later as a message. `autoResumeOnUsageLimit: true` only for such a background run when the user wants bounded automatic continuation after a provider usage window.
- Every call provides exactly one of `name`, `script`, or `scriptPath`.

## Save a reusable workflow

When a script is worth keeping, write it to `.pi/workflows/<name>.js` with the same contract (pure-literal `meta`, one default export, no imports, injected `Type`). Saved workflows are discovered by name, so later runs can use `name: "<name>"` or `/workflow <name>`; `scriptPath: ".pi/workflows/<name>.js"` runs the file directly.
