# Usage

`pi-workflow-engine` adds zero-dependency Dynamax workflows to pi: opt into live, parallel subagents for the tasks that need a custom investigation instead of one long prompt. Most users only need these surfaces:

This release requires **pi 1.0.0 or newer**. pi remains host-provided rather
than bundled by this package, and the extension rejects older runtimes at load
time with an update message.

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
/workflow research "Compare the current Node.js and Bun test-runner watch modes; prefer official docs"
```

The built-in workflows are advisory by default. They inspect, verify, and report; they do **not** edit files. Saved or inline workflows can opt individual agents into disposable git worktrees when they need reviewable patches.

Useful flags:

```text
/workflow code-review --inspect          # show the live inspector while the run is active
/workflow:inspector                      # open the current or last workflow inspector
/workflow code-review --result-viewer    # explicitly open the findings viewer
/workflow code-review --review-viewer    # alias for --result-viewer
/workflow:results                        # reopen the latest code-review findings without rerunning
/workflow code-review --concurrency=4    # cap concurrent subagents
/workflow code-review --max-agents=20    # cap total live agent calls in the run
/workflow code-review --agent-timeout-ms=600000 # abort one live agent after 10 minutes
/workflow code-review --agent-retries=2  # restart agents whose in-session retries are exhausted
/workflow code-review --budget=50000     # output-token ceiling for subagents
/workflow code-review --resume <run-id>  # replay matching completed agent calls
/workflow code-review --resume <run-id> --resume-edited # reuse unchanged calls after a workflow edit
/workflow code-review --refresh          # rediscover newly added workflow files
/workflow:runs                           # browse recent durable project runs
/workflow:inspector <run-id>             # inspect one retained run directly
/workflow:models                         # inspect small/medium/big model routes
/workflow:size                           # show or set the workflow size guideline
```

## Workflow model profiles

Workflow authors can route a stage through `profile: "small"`, `"medium"`, or
`"big"` without hard-coding a provider. Inspect the effective routes with:

```text
/workflow:models
/workflow:models set small openai/gpt-5-mini low
/workflow:models set medium anthropic/claude-sonnet-4-5 medium --project
/workflow:models clear medium --project
```

`set` and `clear` use the user scope unless `--project` is present. User profiles
live at `~/.pi/agent/workflow-models.json`; project profiles live at
`<project>/.pi/workflow-models.json` and override the user file one profile at a
time. A minimal file is:

```json
{
  "profiles": {
    "small": {
      "model": "openai/gpt-5-mini",
      "thinkingLevel": "low"
    },
    "big": {
      "model": "anthropic/claude-opus-4-5"
    }
  }
}
```

Models must be exact `provider/model` identities already available to pi. The
file accepts only `model` and optional `thinkingLevel`; provider credentials and
secrets stay in pi's provider configuration. The engine never ranks models by
price, model-name substrings, or assumed capability.

Routing is resolved per field: an agent's explicit `model` or `thinkingLevel`
wins, then its requested profile, then the profile of its declared phase, then
host inheritance. A phase profile comes from `meta.phases` (`{ title, profile }`)
and applies only to an agent that passes that title as its `phase` option and
sets neither `model` nor `profile`; the global `phase()` call never selects one,
because concurrent branches share it. A configured profile
without `thinkingLevel` inherits the host effort. An entirely unconfigured tier
uses the host model and the built-in bounded effort for that tier (`low`,
`medium`, or `high` respectively); `/workflow:models` labels that route as a host
fallback. Invalid JSON, unknown fields, malformed identities, and configured
models missing from pi's registry fail with the config path and a corrective
command instead of selecting another model.

## Built-in workflows

| Name | Purpose |
| --- | --- |
| `code-review` | Reviews a PR, branch diff, ref range, or focus area. |
| `refactor-scout` | Finds small, safe refactor opportunities. |
| `diagnose` | Investigates a bug, failing command, or regression. |
| `perf-review` | Reviews a slow path or performance concern. |
| `research` | Gathers current external evidence, independently verifies claims, and returns a cited synthesis. |

`code-review` auto-detects a diff when you do not pass args. If there is an open GitHub PR for the current branch, it uses the cumulative PR diff; otherwise it falls back to branch-vs-main/master or `HEAD~1`. Per-commit `gh pr diff --patch` input is rejected because it can surface superseded code. If diff capture fails, the review fails instead of returning an empty report or "no findings."

### External research capabilities

`research` requires at least one installed pi tool whose metadata identifies it
as external web search, browsing, or HTTP(S) page extraction. Local grep/find
tools do not satisfy this check. The workflow does not bundle a scraper or a
paid API; install or enable the web capability you prefer, then restart or
reload pi so subagent sessions can see it. An MCP web search server also
qualifies when the host agent runs `research` through the `workflow` tool,
because only those runs can reach the host's MCP tools.

The workflow bounds decomposition to four lanes and verification to twelve
claims, while the engine's concurrency, total-agent, timeout, cancellation, and
token-budget limits still apply. When gatherers find more than twelve distinct
claims, the most important are verified, and both the run log and the report's
limitations say how many lower-priority claims the cap left unverified. Gatherers retain direct page
titles and URLs; search-results URLs are rejected, sources are canonicalized and
deduplicated, and separate verifier agents classify claims as supported,
conflicting, uncertain, inferred, or rejected before synthesis. External
research calls use `resume: "off"` because live web evidence, time, and service
state are outside the journal's deterministic replay surface.

## Use Dynamax for custom workflows

Use `dynamax` when the built-in workflows are not specific enough and you want the main pi agent to author a temporary workflow for the current question. It is the fastest path from "this needs multiple angles" to a live fan-out, verifier pass, and synthesized result.

Interactive shortcut: run `/workflow` with no arguments, choose `+ author a one-off workflow` (the last row, below the registered workflows), and type a brief. Escape closes the picker without running anything. pi will send that brief back to the host agent as a `dynamax` request so it can author and run an inline workflow with the `workflow` tool's `script` argument.

That inline workflow should investigate, fan out, verify, and summarize. It is **not** where code edits happen. If you want changes made, use the workflow result as evidence and then ask pi to edit separately.

One-off examples:

```text
dynamax author an inline workflow to investigate why typecheck is failing
dynamax create a one-off workflow to compare the parser and tests before we change code
dynamax use parallel agents to review this design and report the risks
```

Sticky mode and inspector shortcut:

```text
/workflow:dynamax          # toggle sticky mode
/workflow:dynamax on
/workflow:dynamax off
/workflow:dynamax status
```

The workflow inspector and code-review results viewer are also registered as first-class shortcuts shown by `/hotkeys`. The defaults are `ctrl+shift+m` for the inspector and `ctrl+shift+r` for the latest review results. `ctrl+o` is intentionally not used because pi already uses it for tool-output expansion and tree filtering.

When only the literal `dynamax` token is used, the opt-in is one-shot: the next agent run receives a `<dynamax>` system prompt section that permits the workflow tool (pi appends it as a section patch, so the cached prompt head is kept), stays visibly active for that run, then clears after the run ends. When `/workflow:dynamax on` (or `/workflow:dynamax` while sticky mode is off) is used, the opt-in is sticky for the current pi session until `/workflow:dynamax off` (or `/workflow:dynamax` again). Sticky mode is a standing default rather than a one-request permission: its `<dynamax>` section tells the host agent to orchestrate every substantive task with the workflow tool, scouting inline first and then running one single-phase workflow per phase (understand, design, implement, review), reading each result before choosing the next, and to work without a workflow only for conversational turns and trivial or already-verified edits. It applies to every run in the session, including runs that a custom message starts, such as a background workflow waking the agent; a one-shot is consumed only by the user prompt that carried it. The footer status states the mode compactly: `◆ dynamax` while sticky, `◆ dynamax · next prompt` while a one-shot waits for its prompt, and `◆ dynamax · this turn` while that run is active; off mode clears it. A running workflow names itself in its own status next to it.

### Prompt editor cue

In TUI mode, every standalone `dynamax` token receives one bounded
moving-shine sweep, then remains as a static multi-colour cue. Longer identifiers
such as `notdynamax`, `dynamaxing`, and `dynamax_mode` are deliberately left
alone. The cue affects rendering only; one-shot and sticky activation semantics
are unchanged.

The default effect is `shine`. Set `PI_DYNAMAX_EFFECT=static` for a motionless
cue or `PI_DYNAMAX_EFFECT=off` to disable it. A non-empty `NO_COLOR` also
disables the default cue; an explicit `PI_DYNAMAX_EFFECT` value takes precedence.

The implementation follows pi's [official `CustomEditor`
pattern](https://pi.dev/docs/latest/extensions#custom-editor): it decorates only
the editor's rendered lines, retaining the wrapped editor's input, cursor,
deletion, paste, multiline, undo, completion, IME, and app-keybinding behavior.

If an editor extension is already registered, pi-workflow-engine composes its
factory and adds only the Dynamax render hook. If that editor cannot be
composed, an explicit warning is shown and pi's stock-compatible `CustomEditor`
is used so highlighting is never silently disabled. Pi editor registration is
still last-writer-wins; the previous editor is restored on shutdown only while
the Dynamax decorator still owns the registration.

When the host agent calls the `workflow` tool, the inspector stays closed so the agent's reply remains in view; the compact workflow widget shows the moving status above the editor. Press the inspector shortcut or run `/workflow:inspector` for the richer view of phases, agents, findings, and logs, live or after the run.

Configure either shortcut by creating `~/.pi/agent/extensions/pi-workflow-engine.json`:

```json
{
  "shortcuts": {
    "inspector": "ctrl+shift+x",
    "results": "ctrl+shift+y"
  }
}
```

Set either shortcut to `null` to disable it while keeping `/workflow:inspector` and `/workflow:results` available.

With Dynamax enabled, the host agent usually calls the `workflow` tool with `script`: a one-off inline workflow tailored to your prompt. It can still call a saved workflow by `name` when one already fits.

Every run that can call the `workflow` tool also carries a `<workflows>` system prompt section: the catalog of registered workflows, one line each with its name, `description`, and `whenToUse`, sorted by name. It is built once per pi session from workflow discovery and reused, so its text is identical on every turn and keeps the provider's prompt cache; start a new session or `/reload` to list workflows added since.

### Workflow size guideline

The catalog ends with one line telling the host agent how large to make each workflow it authors:

```text
/workflow:size                    # show the current guideline and where it comes from
/workflow:size small              # keep each workflow under 5 agents
/workflow:size medium             # under 10 agents (the default)
/workflow:size large --project    # under 25 agents, for this project only
/workflow:size off                # leave the line out
```

The line reads, for example, `Workflow size guideline: medium — keep each workflow under 10 agents unless the user asks for more; the user changes this with /workflow:size.` The setting is stored like the model profiles: `~/.pi/agent/workflow-settings.json` for the user, overridden by `<project>/.pi/workflow-settings.json`; setting a size writes the user file unless `--project` is given. A minimal file is `{ "size": "small" }`. Changing it rebuilds the current session's catalog once.

The guideline only shapes what the host agent writes. The `maxAgents` run limit (default `64`, see [Runtime knobs](#runtime-knobs)) stays the separate hard cap: once a run has started that many live agents, further `agent()` calls fail with `WorkflowAgentLimitError`, whatever the guideline says.

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
  { schema: GapAnalysis, profile: "small" },
);

const followUpItems = gaps?.items.slice(0, MAX_FOLLOW_UPS) ?? [];
const followUps = followUpItems.length
  ? (await api.parallel(
      followUpItems.map((item) => () =>
        api.agent(`Resolve this gap and cite evidence: ${JSON.stringify(item)}`, {
          profile: "small",
        }),
      ),
    )).filter((result) => result !== null)
  : [];

return api.agent(
  `Synthesize the first pass and any follow-ups:\n${JSON.stringify({ firstPass, followUps })}`,
  { profile: "medium" },
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
- workflow-level fresh-input, cache-read, cache-write, output, and cost totals gathered from subagent sessions when provider usage is available.

These workflow usage totals are separate from `--perf`, which is internal timing only. They are also separate from pi's built-in footer and `/session` totals, which may still show host-session usage only unless pi core adds a first-class extension usage API. If a model has no pricing configured, token totals can be non-zero while displayed cost remains `$0.000`.

Results, the inspector overview, the runs browser and the live widget header show usage in the compact form `↑34k ↓1.2k · $0.02` (input including cache, output, and cost when known); the footer status line carries no usage. The result text handed to the host agent keeps the full breakdown: providers with a complete breakdown show `fresh`, `cache read`, `cache write`, and `output` separately. Zero cache components are omitted. If a provider reports only some components, the summary labels mixed-run component totals with `≥` and preserves the provider's aggregate `total`; if it reports no components, the summary falls back to aggregate `tokens`. Costs are summed from provider session totals and are never inferred from local pricing.

During a run, a widget above the editor shows the workflow's progress bar, finished/total agents, elapsed time and usage; phases in chronological order, with finished phases collapsed to one line and the active phase listing its running, failed and done agents; the declared phases not reached yet; the workflow's counters; and the inspector shortcut. The footer status line reads `◆ review · Find 6/10 · 12s`. Use `--inspect` if you want a larger live view while the workflow is active, then `/workflow:inspector` if you want to bring the last completed inspector back up afterward.

The inspector has Overview, Agents, Findings, and Logs sections, plus Result for a retained run opened from `/workflow:runs`. Switch sections with `tab`/`shift+tab`, `←`/`→`, or `1`–`5`; move with `↑`/`↓` or `j`/`k`, jump with `g`/`G`, expand an agent or finding with `enter`, and close with `q` or `esc`. Expanded agents show the full error, last tool, model, and token usage.

While a run is live, `s` on the Agents tab skips the selected running agent: press it twice on the same agent (like stopping a run in the runs browser); the key is listed in the footer only while the selection can take it. Skipping aborts only that agent's session; the run and its sibling agents carry on. The skipped `agent()` call rejects with a recoverable `WorkflowAgentSkippedError` (code `WORKFLOW_AGENT_SKIPPED`), so `parallel()` and `pipeline()` turn it into a `null` slot while a direct `await` sees the error. A skipped agent is never restarted by `agentRetries` and never written to the replay journal, so a resumed run asks it again; the tokens it already spent still count toward usage and the budget. The widget, inspector and run record show the agent as `skipped`. Skipping works for a background run too when you open its live inspector with `/workflow:inspector` or the shortcut; a retained run opened from `/workflow:runs` is read-only.

### Durable run records

Every workflow run writes a versioned project-local record to `.pi/.workflow-runs/<run-id>.run.json`; its agent replay journal remains `.pi/.workflow-runs/<run-id>.jsonl`. The same run ID appears in execution metadata, progress snapshots, result details, and both filenames. Records distinguish `queued`, `running`, `completed`, `failed`, `stopped`, and `paused` lifecycle states and retain resolved scalar options, timestamps, compact progress, summary usage, and the final result or error.

Record replacement is atomic, corrupt or unsupported-version files are ignored independently, and the newest 50 run records are retained. Journal retention remains 50 files. Both record and journal files are excluded from repository resume fingerprints, so checkpoint writes do not invalidate replay.

Persistence is intentionally bounded and private by default. Raw workflow args, prompts, subagent transcripts, progress logs, lane details, agent errors, environment data, credentials, and tool-output-shaped fields are not stored. Final results are limited to bounded plain JSON; credential- and transcript-shaped fields are redacted, and unsupported or cyclic results are marked unavailable instead of executing accessors or breaking the workflow. Loading history only parses these data files and never imports or executes workflow code.

An inline run (a tool `script` or `scriptPath`) also saves its script to `.pi/.workflow-runs/<run-id>.script.js`, a separate file the record only references, because the record never holds prompts. The script holds nothing new: pi's session transcript already contains it as the tool call's arguments. A pruned record takes its script with it. Whenever the engine creates `.pi/.workflow-runs/`, it adds a `.gitignore` containing `*` so run files stay out of the project's git history; an existing `.gitignore` there is never replaced.

The result handed to the host agent names the run's files after the run ID: `Script:` for an inline run, and `Journal:` with a reminder to read the journal before diagnosing an empty or unexpected result. A failed inline run lists the same lines after its error, and a background start names the script too. To iterate, edit the script and rerun it with `scriptPath` (see [Author an inline workflow](#author-an-inline-workflow)).

### Background workflows

The host-facing `workflow` tool accepts `background: true`. It returns as soon as the run ID and origin metadata are durably recorded, while the normal workflow engine continues in-process with the same concurrency, budget, worktree, progress, usage, and resume rules. Synchronous execution remains the default, and the `/workflow` slash command remains synchronous.

Background runs are detached from the initiating tool-call signal, so the host agent can finish that turn and continue the conversation. While one runs, it shows a single line above the editor (`◆ background · code-review 56b57550 · Find 6/10 · 12s`) instead of the full live widget. When the run completes or fails, the extension waits for the originating session to become idle and inserts one concise `workflow-result` message containing the run ID, terminal state, and summary. Delivery state is stored with the run record; on reload, the extension checks both that state and the session message history before retrying, which suppresses duplicates even if persistence failed immediately after message insertion.

If Dynamax was active when the host agent started the run (sticky mode, or the turn a `dynamax` one-shot covered), the delivery also starts a new agent turn, so the agent wakes to read the result and choose its next step without waiting for you; with sticky mode on, that turn carries the sticky `<dynamax>` section. The run record keeps this as `background.origin.wakeOnComplete`, so a delivery after a restart, including the notice for a run paused by shutdown, still wakes the agent, and a resume, restart, or provider-limit auto-resume of that run wakes it too. Other background runs keep the silent delivery above. There is no separate flag: Dynamax being active is the signal that the agent is orchestrating.

Provider usage-window continuation is a separate, explicit background option:

```json
{
  "name": "code-review",
  "background": true,
  "autoResumeOnUsageLimit": true,
  "usageLimitMaxAttempts": 3,
  "usageLimitMaxDelayMs": 21600000
}
```

It is off by default and schedules only registered file workflows and inline runs whose script was persisted, and only when the invocation had no arguments; argument-bearing runs still pause safely but require an explicit manual decision because their arguments are not persisted. A recognized provider usage or quota failure aborts the current fan-out before queued agents can open new sessions, preserves the replay journal, and records a sanitized provider message, provider identity, reset hint, total attempt number, and next eligible time. Transport failures and ordinary provider errors keep the existing per-agent `agentRetries` behavior and do not create a provider-limit pause.

Reset parsing accepts provider duration hints such as `retry-after: 60` and `x-ratelimit-reset-tokens: 6m0s`, plus future RFC3339 timestamps. Missing, past, or malformed hints use a 60-second fallback; delays are clamped to at least 5 seconds and at most `usageLimitMaxDelayMs`. The default maximum is three total run attempts, including the initial run. When the eligible time arrives, the extension starts a new background run with `resumeFromRunId`; after a process restart, it re-arms only the remaining delay. `/workflow:runs resume` and `/workflow:runs stop` cancel any pending timer, and the attempt cap prevents an infinite resume loop.

The equivalent environment defaults are `PI_WORKFLOW_USAGE_LIMIT_AUTO_RESUME=1`, `PI_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS`, and `PI_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS`. Per-tool-call values take precedence.

A graceful pi session shutdown aborts active background work and records it as `paused` instead of successful. Reopening the same session after an ungraceful process exit also reconciles a retained `queued` or `running` background record to `paused`. Resuming the originating pi session delivers that interruption once. If the originating session no longer exists, the record remains in `.pi/.workflow-runs/`, delivery is marked unavailable, and a fallback is written to stderr. Background mode is supported in long-lived TUI and RPC sessions; `print` and `json` modes reject it because those processes exit after the prompt. This feature is in-process rather than a daemon: a hard process kill cannot keep model work running, but the last atomic run checkpoint remains available.

### Recent runs and lifecycle actions

`/workflow:runs` opens a runs browser in the TUI: one aligned row per recent project run (state glyph and word, workflow, duration, age, cost when known, short run ID) above a details pane for the selected run with its wall-clock times, phases, agent and token counts, resume lineage, pause details, outcome, and why a relaunch is unavailable when it is. Keys act on the selected run: `enter` or `i` inspect, `r` resume, `s` stop (press twice), `R` restart; only the actions currently valid for that run are listed in the footer, and the others explain why they are unavailable. The browser refreshes while a run is active and reopens on the same run after an action. RPC sessions keep pi's native two-step selection (run, then action). The background activity line is present only while this session owns active background work.

The same operations are available without the selection UI:

```text
/workflow:runs inspect <run-id>
/workflow:runs stop <run-id>
/workflow:runs resume <run-id>
/workflow:runs restart <run-id>
/workflow:inspector <run-id>
```

Inspect is always safe. Stop is available for a background run active in the current session and for a retained paused run with a pending resume timer. Resume is limited to paused runs whose source fingerprint is unchanged and whose invocation had no redacted arguments; it starts a new background run ID with `resumeFromRunId` journal replay. A paused run already resumed by a queued, running, paused, or completed run is listed as `resumed as <run-id>` and offers no second resume; once every resume of it has failed or been stopped, manual resume is offered again, while automatic provider-limit resume never fires twice for the same paused run. Restart is limited to completed, failed, or stopped runs that had no arguments and also creates a new background run ID. A registered workflow relaunches by name; an inline run relaunches from its persisted `<run-id>.script.js`, so it is relaunchable only while that script is retained, and fails with a clear message if the file was deleted. Argument-bearing invocations are intentionally not relaunched because their arguments were not persisted. In `print` and `json` modes, list and inspect return formatted text without opening TUI components, while resume/restart report that background execution requires TUI or RPC mode.

Code-review findings are rendered as a formatted result message by default. pi no longer asks whether to open the findings viewer. Use `--result-viewer` or `--review-viewer` when you want to inspect findings interactively. The viewer lists findings most severe first with the selected finding's full detail beside the list (below it in narrow terminals); `space` or `enter` selects a finding, `a` toggles all, `f` generates patch previews and `c` posts PR comments for the selection, and `pgup`/`pgdn` scroll a long detail. The viewer is sized to its content and shows scroll hints only when something is clipped. `/workflow:results` or `ctrl+shift+r` reopens the most recent validated code-review report in the current pi session without rerunning the workflow; selections reset when it reopens.

The Fix action revalidates the exact reviewed PR/ref/index/working-tree snapshot, then runs each selected finding through its own worktree-isolated agent and returns the finding ID, validation summary, patch, and changed status. Failed attempts do not discard successful previews, no patch is applied to your active tree automatically, and a moved or unverifiable review target is rejected rather than patched against the wrong code. The original review and all Fix previews retained in that pi session share one output-token budget. Reopening the viewer does not reset it, finalized preview usage is always deducted, and only one preview can run at a time.

Inline GitHub comments are available only for findings captured from a verified PR target. Before posting, the engine revalidates the reviewed snapshot and requires the current PR head to match; identical comments on that head are skipped.

### Resume a run

Every workflow result includes a run id. Resume with:

```text
/workflow code-review --resume <run-id> HEAD~3
/workflow code-review --resume <run-id> --resume-edited HEAD~3
```

The `workflow` tool exposes the same features as `resumeFromRunId` and the opt-in `resumeEditedWorkflow: true`. By default, any workflow source change invalidates every prior call. Edited-workflow resume waives only that source-fingerprint mismatch: repository state, runtime, model, system prompt, thinking level, prompt, schema, ordered skills, tools, isolation, and all other replay checks must still match.

With edited-workflow resume enabled, unchanged calls are reused while changed or newly added calls run live. Matching uses a stable behavioral hash, not call or completion order. Repeated identical calls are deliberately ambiguous and run live unless each logical call has a stable, distinct `cacheKey`. The new run record retains the opt-in policy and reports cached and live agent totals. The engine only inspects the prior run's JSON journal; it never loads or executes the prior workflow source.

This option can return a result produced before an orchestration edit when that call's explicit identity did not change. Use it only when the unchanged call is still semantically valid in the edited workflow, and prefer stable `cacheKey` values for repeated logical calls. Omit `--resume-edited` or `resumeEditedWorkflow` for the fail-closed default.

A tool call with `scriptPath` and `resumeFromRunId` implies `resumeEditedWorkflow: true`, because rerunning an edited script file is what `scriptPath` is for. Only the whole-script fingerprint check is relaxed; each call's own replay identity still decides whether its cached result is reused.

Replay is explicit for agents that share the workflow directory and automatic for isolated patch-producing agents:

| Agent call | Default during resume | Override |
| --- | --- | --- |
| Shared workspace | Runs live | `resume: "read-only"` opts into repository-wide Git-visible replay; `resumeInputs` adds ignored paths under the workflow cwd |
| `isolation: "worktree"` | Replays when identity matches | `resume: "off"` forces a live run |

Use `resume: "read-only"` only when the shared agent is advisory. In Git repositories the engine resolves the repository root and binds replay to HEAD, staged and unstaged tracked changes, index modes, and bounded non-ignored untracked contents across that whole worktree, even when pi starts in a subdirectory. Add ignored or generated files under the workflow cwd with cwd-relative `resumeInputs`; explicitly named ignored paths are fingerprinted directly and cannot escape that cwd. The complete identity is checked before accepting a hit, after execution, and again after cleanup. A changed surface turns a hit into a live run and prevents unsafe recording. Tracked symlinks, submodules, and unsupported index states fail closed. Use `resume: "off"` when the call may inspect undeclared ignored files, external paths, services, environment, or clock state.

Journals use replay contract v2. A hit requires the same prompt/options and execution identity: repository-wide Git-visible state plus explicitly declared ignored inputs, workflow source provenance, coding-agent runtime version, effective system prompt/provider/model/thinking level, ordered selected skill contents, and ordered executable tool definitions plus source fingerprints. Unverifiable, cyclic, oversized, symlinked, submodule-backed, or mutable identity surfaces fail closed and run live. A tool-free structured agent uses a capability identity instead of hashing a workspace it cannot observe; an isolated agent binds replay to both the commit and tree objects of its exact prepared worktree baseline, including deterministic normalized snapshots for repositories with no commits. Each resumed run writes a fresh journal under its new run id, and cached results do not add usage or budget spend.

Cached values are revalidated before use: text must still be text, structured output must satisfy the current typebox schema, and an isolated patch must have consistent metadata and pass `git apply --check --binary` against its fresh baseline worktree. A malformed or stale value runs live.

Invalidations appear in progress output with a concise reason. Legacy v1 journals and early v2 entries without effective-session identity are parsed for compatibility but always miss. Journals written by pi-workflow-engine 1.1.0 or earlier miss once with `effective system prompt changed`, because later versions append the return-value instruction to every subagent's system prompt; the resumed run records fresh entries. Git repositories with no commits and non-Git directories remain supported. Git control data and engine-owned workflow journals cannot be declared as inputs; if a Git-visible or explicit surface exceeds safety bounds, that call runs live.

Statically loaded built-ins fingerprint and revalidate their bounded extension source tree so imported helper changes invalidate replay, while inline workflows and saved `.js` scripts use the compiler-provided script fingerprint. Dynamically discovered `.ts` and programmatic modules are intentionally non-replayable because their transitive runtime imports or captured closures cannot be bound to an immutable source snapshot.

Resume only caches completed `agent()` calls. It does not snapshot arbitrary workflow local variables, in-flight tool work, environment or clock state, external services, or generated inputs outside the captured repository/workflow/skill/tool surfaces. Use `resume: "off"` for calls that depend on those values, and keep prompts and options deterministic when you want cache hits.

## Author a saved workflow

Saved workflows are TypeScript modules with `meta` plus a default async function:

```ts
import { Type } from "typebox";
import { compactResults } from "../src/concurrency.ts";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "my-workflow",
  description: "Find and summarize something important.",
  whenToUse: "Use when the user wants the important thing found and summarized; args name the target.",
  phases: [
    { title: "Find", detail: "Two independent finders", profile: "small" },
    { title: "Synthesize", profile: "medium" },
  ],
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
      () => agent(`Find correctness issues: ${args}`, {
        schema: Finding,
        tools: SEARCH_TOOLS,
        toolHints: SEARCH_TOOL_HINTS,
        profile: "small",
        resume: "read-only",
      }),
      () => agent(`Find edge cases: ${args}`, {
        schema: Finding,
        tools: SEARCH_TOOLS,
        toolHints: SEARCH_TOOL_HINTS,
        profile: "small",
        resume: "read-only",
      }),
    ]),
  );

  phase("Synthesize");
  return agent(`Summarize: ${JSON.stringify(findings)}`, {
    profile: "medium",
    tools: [],
    resume: "read-only",
  });
}
```

`meta.name` is required. `description` and `whenToUse` describe the workflow in the picker and in the host's workflow catalog, so write `whenToUse` as the situation that should make a model choose it and what `args` it expects. `phases` declares the progress phases up front; each may add a one-line `detail` and a default `profile` for agents that pass that phase title as their `phase` option.

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

Every subagent's system prompt states that its return value goes to the workflow program as data, not to a person: a text agent's final message is returned verbatim, so it replies with only the output its task asks for (no greeting, preamble, narration, or offer of further help), and a schema agent is told the same about its `final_answer` arguments. The instruction is appended after any `APPEND_SYSTEM.md` pi discovers, which subagents keep loading.

`args` holds the invocation's arguments as text and `input` holds them verbatim. A slash command passes a string, so both are that string. The `workflow` tool's `args` field and `workflow(ref, args)` also accept any JSON value: `input` is the value and `args` its JSON text, so workflows written for string arguments keep working. Omitted arguments are `""` in both. Like string arguments, JSON arguments are never written to the run record, so a run that had any cannot be resumed or restarted from `/workflow:runs`.

Schema agents accept structured output only through the validated, terminating `final_answer` tool. If the first response omits it, the engine makes at most **two repair attempts** (three prompt attempts total). Repair prompts expose only `final_answer` when the active pi session supports tool restriction. Clean exhaustion throws `WorkflowStructuredOutputError` with code `WORKFLOW_STRUCTURED_OUTPUT_NONCOMPLIANCE`; provider failures and host cancellation still propagate unchanged.

Use settled mode when the workflow must distinguish a successful `null` from a failed branch. It preserves input order and returns `{ ok: true, value }` or `{ ok: false, error: { name?, message, code?, details? } }` for every thunk. Default parallel mode still turns recoverable structured-output exhaustion into a `null` slot, while settled mode retains the typed code and attempt details. Genuine workflow cancellation still rejects the whole `parallel()` call and cancels siblings.

Direct schema calls can catch the typed failure instead of receiving an unexplained `null`:

```ts
try {
  return await agent("Return the result.", { schema: ResultSchema });
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "WORKFLOW_STRUCTURED_OUTPUT_NONCOMPLIANCE") {
    log("The agent did not produce compliant structured output.");
    return undefined;
  }
  throw error;
}
```

Set a model `profile` on each stage so users can tune workflow routing centrally.
Use explicit `model` or `thinkingLevel` only when that one call intentionally
overrides its profile.

`tools` is a strict allowlist. If you set `tools: ["read", "bash"]`, extension tools such as `ast-grep`, `mgrep`, `fffind`, or `ffgrep` are hidden from that subagent. Add `toolHints: ["search"]` to dynamically expose installed grep/find/search-like tools while keeping the concrete base allowlist portable. Use `toolHints: ["external-search"]` for installed web search, browsing, and URL-extraction tools; `requireToolHints: true` fails before prompting unless each requested capability matched. The built-in advisory workflows use `tools: ["read", "bash", "grep", "find", "ls"]` plus `toolHints: ["search"]`.

Subagents are SDK sessions, so pi's built-in codemode and MCP extensions do not load in them. Two opt-ins cover that:

- **Codemode.** Add `"codemode"` to an agent's `tools` to let it batch or filter many tool calls in one script, for example `tools: ["read", "grep", "codemode"]`. Scripts can call only that agent's other allowed tools, and never `final_answer`. Classifier calls a script makes count toward the run's usage and budget. pi runs at most two codemode scripts per process, shared with the host, and fails a third instead of waiting; subagents' codemode calls therefore queue for one of those two slots, so a wide fan-out of codemode agents runs their scripts two at a time. A codemode agent runs its tool calls one at a time, and so do its scripts' own calls: by default pi checks every call in a message before it starts any, and a codemode call takes its slot in that check, so three codemode calls in one message would hold both slots with calls that cannot start while the third waits for one. To batch calls, put them in one script, which still makes them all in a single model turn. pi frees a slot only once the script's worker has exited, which can lag its result, so an agent can occasionally still get pi's "Codemode worker limit reached" error and retry. The host's own codemode calls do not queue.
- **Host MCP tools.** In runs started by the `workflow` tool, subagents reach the host's MCP tools over its existing connections and through its permission handlers. Name a tool in `tools` (for example `"mcp__linear__create_issue"`), or use `toolHints: ["external-search"]` to pick up MCP web research tools; servers that declare a tool not read-only or closed-world are excluded from that hint. Bridged tools act in the host session, so the local `search` hint never bridges them, and an isolated worktree agent that names a local MCP tool sees the main checkout through it, not its worktree. `/workflow` commands and background runs outlive the host tool call that makes this possible: an agent there that names an MCP tool fails before prompting rather than running without it. So that a run started early in a session does not race servers that are still connecting, the `workflow` tool tells pi (1.2 or newer) which servers a call may reach, and pi waits for them before the run starts: the servers of the `mcp__…` tools an inline script or `scriptPath` file names, or every server for a named workflow, a script that uses `external-search` hints or `workflow()`, or a `scriptPath` that cannot be read. A background call waits for none. Each server becomes ready once, so the wait costs at most one pause at session start.

Subagents receive no skills by default. Opt in per agent with `skills: ["skill-name"]`; if `tools` is also restricted, the engine automatically keeps `read` available so the subagent can load the selected `SKILL.md`. When `skills` is omitted, clear prompt text such as `/skill:name`, `include skill name`, or `use the name skill` is also treated as an opt-in. Pass `skills: []` to suppress that inference.

Set `model` only when a subagent should use a specific model. Bare ids keep the Anthropic shorthand; `provider/id` targets built-in, custom, or local providers. Explicit models override a requested profile; calls with neither inherit the host/session default. Malformed or unknown explicit refs fail fast.

### Mutating agents in worktrees

Use `isolation: "worktree"` only for agents that should edit files. The agent runs in a detached git worktree, the engine captures its net patch, then the worktree is removed. The user's working tree is not changed.

```ts
const edit = await agent("Rename this helper and update its call sites.", {
  tools: ["read", "bash", "edit", "grep", "find", "ls"],
  isolation: "worktree",
  profile: "medium",
});

if (edit.changed) {
  return { summary: "Patch ready for review.", patch: edit.patch };
}
return { summary: edit.result };
```

Isolated agents require the workflow `cwd` to be inside a git work tree. Outside git, the agent fails fast rather than silently mutating the shared directory. The return value is `{ result, patch, changed }`, where `result` is the normal text or structured `agent()` result and `patch` is a `git diff HEAD` patch. Worktree results are replayable by default; add `resume: "off"` when their inputs are not fully captured. Worktree setup costs disk and git process time, so keep it opt-in for mutating/parallel-edit stages.

Cleanup is a required finalizer. The engine attempts every registered worktree removal, retains failed paths for another cleanup attempt, and fails the workflow with the aggregated cleanup error if any worktree still cannot be removed. Advisory finalizers such as UI snapshots and journal pruning do not replace an otherwise valid workflow result.

### Compose workflows

`workflow(ref, args?)` runs a registered workflow by name, or an inline-format script file via `{ scriptPath }`, as a sub-step, returning its result. `args` is a string or any JSON value, which the child reads as `input` and, as text, `args`. The child shares the parent run's concurrency cap, total-agent limit, per-agent timeout, abort signal, and perf timing, and its phases nest under `<name> ▸ <phase>` in the live UI.

```ts
export default async function run({ workflow }: WorkflowApi) {
  const review = await workflow("code-review", "HEAD~3");
  const audit = await workflow({ scriptPath: "scripts/audit.js" }, { paths: ["src/"], strict: true });
  return { review, audit };
}
```

A `scriptPath` is resolved against the workflow cwd and must stay inside it after symlinks are resolved; the file follows the [inline workflow rules](#author-an-inline-workflow) and is fingerprinted by content like an inline script. Nesting is one level only: calling `workflow()` from inside a sub-workflow rejects. Resolution throws on an unknown name, a `scriptPath` outside the cwd or unreadable, or a script that does not compile. Inside `parallel()` or `pipeline()`, recoverable branch errors become `null` results, so filter nulls before synthesis; a genuine run abort still rejects.

### Classify between stages

`classify(context, opts?)` answers typed `choice`, `score`, or `bool` questions about JSON `state` with one of pi's classifier models (for example TypeSafe Jev or Cloudflare Clef), using the host's credentials and no chat session. It suits cheap gates between stages, such as deduplicating findings or deciding which items need a follow-up agent.

```ts
const answers = await api.classify(
  {
    state: { finding },
    questions: {
      followUp: { type: "bool", instructions: "Does this finding need verification?", criteria: { true: "Plausible but unproven", false: "Clearly settled" } },
    },
  },
  { label: `triage:${finding.id}` },
);
if (answers.followUp?.type === "bool" && answers.followUp.probability > 0.5) { /* verify it */ }
```

Without `opts.model` ("provider/id"), the first classifier with working credentials is used. Calls share the run's concurrency cap, count toward usage and the budget, and are not journaled, so a resumed run classifies again. When no classifier is configured the call rejects with a recoverable error, so guard it or let `parallel()` turn it into `null`.

### Where workflows live

Guaranteed built-ins are statically registered:

1. Add `.pi/extensions/pi-workflow-engine/workflows/<name>.ts`.
2. Import it in `.pi/extensions/pi-workflow-engine/src/workflows.ts`.
3. Add a `defineBuiltinWorkflow(mod, "<name>.ts")` entry to `BUILTIN_WORKFLOW_DEFINITIONS`.

Saved scripts are workflows in the [inline script format](#author-an-inline-workflow) kept as `*.js` files:

- `<project>/.pi/workflows/*.js`: project workflows, shared through the repository.
- `~/.pi/agent/workflows/*.js` (pi's configured agent directory): user workflows, next to the `.ts` drop-ins.

They compile like an inline `script`, with the injected `Type` and no imports, so they share pi's typebox, unlike `.ts` drop-ins, and they are fingerprinted by content, so `--resume` and `/workflow:runs` resume and restart them like built-ins. Project scripts load only when pi reports the project as trusted (`ctx.isProjectTrusted()`). pi itself does not ask for trust because of `.pi/workflows` alone, so a folder with no other protected project resources counts as trusted; review a repository's `.pi/workflows` before running them. Files starting with `_` or `.` and scripts that do not compile are skipped with a stderr note.

Drop-in workflows are also discovered best-effort from:

- `~/.pi/agent/workflows/*.ts`: the user-level drop-in directory, which survives `pi update`.
- The extension's own `workflows/*.ts` directory: `.pi/extensions/pi-workflow-engine/workflows/` in a working copy or a project-vendored copy. Files added to an installed package are replaced by `pi update`.

When two sources define the same name, the first wins: built-ins, project scripts, the extension's `.ts` drop-ins, user scripts, then user `.ts` drop-ins. Use `/workflow <name> --refresh` after adding or editing a saved script or drop-in file.

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
    () => agent(`Find correctness issues: ${args}`, { schema: Finding, profile: "small" }),
    () => agent(`Find edge cases: ${args}`, { schema: Finding, profile: "small" }),
  ]);
  return { summary: JSON.stringify(findings) };
}
```

Inline rules:

- start with `export const meta = { ... }`;
- default-export an async workflow function;
- write plain JavaScript: the script compiles in-process, so TypeScript annotations do not parse;
- no imports or dynamic `import()`;
- use the injected `Type` object for schemas;
- request `profile: "small"`, `"medium"`, or `"big"` instead of hard-coding provider models when the stage is portable;
- add `skills: ["skill-name"]` per `agent()` call when a subagent should use a pi skill; no skills are exposed by default;
- no extra exports or code after the default export.

Inline workflows run in-process with extension permissions, so treat them as trusted task automation.

The host agent's reference for writing these scripts is the bundled `workflow-authoring` skill (`skills/workflow-authoring/SKILL.md`). The `workflow` tool's guidelines stay short (the opt-in rule, the target and `Type` rules, profiles, the worktree return shape, host MCP reach, and the run-mode flags) and tell the model to read the skill before it writes or edits a script. The skill covers the full API, why fan-out uses `api.parallel` rather than `Promise.all` and defaults to `api.pipeline`, verification and completeness patterns, budget loops, worktree edits, resume, and saving a reusable workflow.

The tool also takes `scriptPath` in place of `script`: a file holding an inline script, relative to the working directory and inside it after symlinks are resolved. Each tool call gives exactly one of `name`, `script`, or `scriptPath`. Every inline run saves its script as `.pi/.workflow-runs/<run-id>.script.js` and names it in the result, so iterating does not need the script pasted again: edit that file (or a copy), then call the tool with `scriptPath` and `resumeFromRunId` set to the previous run. Replayable agent calls (see [Resume a run](#resume-a-run)) that the edit left unchanged are reused; edited and new calls run live.

## Runtime knobs

Only tune these when a workflow is too slow, too expensive, or too noisy:

| Knob | Meaning |
| --- | --- |
| `--concurrency=N` / `PI_WORKFLOW_CONCURRENCY=N` | Cap concurrent subagents. Default is `min(8, max(2, CPU count))`. |
| `--parallel-limit=N` / `PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT=N` | Limit eager `parallel()` submission. |
| `--max-agents=N` / `PI_WORKFLOW_MAX_AGENTS=N` | Cap live model calls across the complete run, including sub-workflows. Default `64`; values are clamped to `1`–`10000`. Replay hits do not consume the cap. The `workflow` tool field is `maxAgents`. This is independent of the `/workflow:size` prompt guideline. |
| `--agent-timeout-ms=N` / `PI_WORKFLOW_AGENT_TIMEOUT_MS=N` | Abort one live agent after this duration. Default `1800000` (30 minutes); values are clamped to `1000`–`86400000`. The session is aborted and its isolated worktree is cleaned up. The `workflow` tool field is `agentTimeoutMs`. |
| `--agent-retries=N` / `PI_WORKFLOW_AGENT_RETRIES=N` | Restart the whole agent after a transient provider or transport failure that pi's in-session turn retry could not recover. Default `0`; values are clamped to `0`–`10`. Backoff starts at one second, doubles, and caps at 30 seconds. The `workflow` tool field is `agentRetries`. |
| `--budget=N` / `PI_WORKFLOW_BUDGET=N` | Set an output-token ceiling across recorded subagent attempts, including failed provider attempts. `agent()` throws `WorkflowBudgetExceededError` before starting another model request once the ceiling is reached; agents already running may overshoot because the engine does not reserve per-agent estimates. |
| `--perf` / `PI_WORKFLOW_PERF=1` | Include internal timing aggregates. Usage/cost totals are reported separately from perf. |
| `PI_WORKFLOW_LANE_ITEM_LIMIT=N` | Cap retained progress lane items. |

These controls bound different dimensions: concurrency limits how many agents
are active together, `max-agents` limits how many live model calls the run may
start in total, `agent-timeout-ms` bounds one active call (including retry
backoff), and `budget` limits recorded output tokens. Every agent restart consumes
another live-agent admission and remains inside the original timeout, budget,
and abort scope. Usage from failed attempts is retained, so it can exhaust the
budget before the next retry begins. Host cancellation takes precedence over
limit and timeout failures.

### Turn budget directive

Put a standalone `+N` token in a prompt to give that turn's workflow runs one
shared output-token pool:

```text
dynamax +500k review this branch and verify every finding
+1.5m map every caller of the old API, then propose the migration
```

The token takes `k` or `m` suffixes in either case (`+500k`, `+1.5m`, `+2M`) or
a plain count (`+250000`). It must follow the start of the prompt or whitespace
and end at whitespace, punctuation, or the end, so `C++`, `a+500k`, or `+500kb`
do not count, and values under 1,000 tokens are ignored so a `+1` in ordinary
prose never caps a run. The first such token in a typed prompt wins; prompts
that extensions send are not read.

While the pool is active, a `workflow` tool call without its own `budget` runs
with the pool's remainder as its budget (clamped to the tool's budget range),
and each synchronous run's output tokens are subtracted once it finishes,
failed or not. When less than one token remains, the tool refuses the call and
tells the agent the turn's budget is spent. An explicit `budget` on the call
still wins but its spend is still subtracted. The pool clears when the run that
received the prompt settles, so it still covers the run after pi retries a
provider error or compacts an overflowing context within that run.

Background runs receive the current remainder as their budget but do not draw
the pool down, because their usage lands after the turn. Parallel `workflow`
calls in one assistant message each see the same remainder before any of them
finishes. Per-run budget accounting is unchanged either way.

Transient provider failures are retried in two layers. First, each subagent
inherits pi's session-level automatic retry from your pi `retry` settings
(enabled by default: 3 retries with 2s, 4s, 8s backoff). It retries the failed
turn in place, keeping the agent's earlier tool work; each attempt is logged in
the workflow progress log, and usage from failed attempts is still recorded.
Like the agent's other turns, these in-place retries are not budget-checked, and
a retryable rate-limit or usage-limit error is retried in-session before a
background run's usage-limit pause takes effect. Only when those retries are
exhausted does `--agent-retries` restart the agent from scratch. Invalid
models, schema-contract failures, exhausted budgets, agent limits, worktree
failures, timeouts, and host aborts are never provider-retried.

pi-workflow-engine 0.12.0 and 0.13.0 wrote `"retry": {"enabled": false}` into
`~/.pi/agent/settings.json` whenever a workflow ran, which disables automatic
retry for the host session and every subagent. Workflow runs log a warning while
that setting is in effect; remove it unless you disabled retry on purpose.

## Common fixes

- **Unknown workflow**: confirm the extension is loaded with `pi list`; use `--refresh` for new drop-ins.
- **Inline compile error**: check the inline rules above.
- **Slow run**: lower fan-out, set `thinkingLevel`, or reduce `--concurrency`.
- **Budget exhausted**: narrow the target, raise `--budget`, reduce fan-out/concurrency, or guard custom loops with `api.budget.remaining()`.
- **Duplicate command/tool warnings while developing**: avoid loading both the global package and the working copy.

### Advisory evidence and coverage

`code-review`, `diagnose`, `refactor-scout`, and `perf-review` retain candidate IDs
from discovery through verification and synthesis. Findings contain
`sourceCandidateIds`; merged findings retain all contributing IDs, locations, and
evidence. Code review uses `reviewAnchor` for the changed line that caused the
finding. Other `locations` can identify unchanged callers or related files.

These results include `status` (`complete` or `incomplete`), `coverage` with
expected/completed/failed branch counts and failure reasons, `gaps`, and the
`verification` records. Failed verification is not a refutation. Verifiers use
`NOT_SUBSTANTIATED` when evidence is insufficient and `REFUTED` for concrete
disproof. A failed finder or verifier prevents a clean conclusion. If synthesis
fails, the result retains verified records and reports incomplete coverage.
Synthesis selects or merges IDs; the workflow reconstructs evidence-bearing
fields from those records.

Each lens verifies at most the per-lens candidate count its finder prompt
states (six per `code-review` angle, four or five for the other workflows).
When a finder returns more, the workflow logs how many it cut from that lens.
`stats.candidates` counts everything the finders returned, and `stats.dropped`
counts the candidates never verified: those over a lens cap, duplicates, and
out-of-scope candidates.

### Duplicate candidates

Lenses often report the same defect in different words. When a TypeSafe Jev
classifier is reachable (TypeSafe directly, OpenRouter, Cloudflare Workers AI,
Vercel AI Gateway, or OpenCode Zen), the four advisory workflows ask it whether
each pair of candidates in the same file describes one defect. Before
verification, a candidate joins a group only when the classifier is at least 80%
sure it matches every member, so each defect gets one verifier. Merged
candidates keep all of their source IDs, locations, impacts, and evidence, and
the verifier sees the other wordings as "Also reported as" evidence. If the
first comparison fails (no Jev credentials, a bad key, a rate limit), the merge
is skipped.

Measured on GPT-6.1 Sol code reviews with planted bugs, the merge cut verifier
agents and cost by about 40% (e.g. 29 → 18 agents, $0.60 → $0.37 list price on
a small diff; 22 → 14 agents, $1.74 → $0.89 on a 160 KB diff). In every
instrumented run, each planted bug that a finder proposed reached the final
report, with or without merging.

### Selective adversarial challenges

Add `--challenge` to an advisory workflow to challenge up to three uncertain or
high-risk findings. `--challenge=N` requires a non-negative integer and sets the
limit, capped at ten; zero disables it. Invalid values stop the workflow before
agents start. Ordinary confirmed, low-risk findings bypass this stage.

```text
/workflow code-review --challenge=2
/workflow diagnose --challenge failing retry test
```

The challenger tries to disprove the finding or identify an alternative cause.
A separate adjudicator receives both sides. Unresolved disagreement remains
`NOT_SUBSTANTIATED`; finding no counterexample does not upgrade confidence.
Custom workflows can use the `challengeFindings` recipe with `maxChallenges`
and a `shouldChallenge` predicate, including selection based on domain-specific
severity. It uses the existing `agent` and settled `parallel` calls.

### Independently validated repair candidates

The results viewer's fix action produces candidate patches in disposable
worktrees. Each candidate retains the implementer's report separately from its
`validation` record: reviewed baseline fingerprint, baseline commit, patch
SHA-256, evaluator decision, executed commands, output, and process results.

A fresh evaluator receives the exact reviewed baseline plus captured patch.
The engine reconstructs another workspace and executes the evaluator's focused
checks. Where applicable, a test-only patch and expected failure text let it
check that a regression fails on the original baseline and passes after repair.
Outcomes are `verified`, `rejected`, `blocked`, or `no-patch`. Missing required
validation blocks verification. An empty patch does not prove that a finding
needs no repair. Rejected and blocked candidates retain their patch and failure
evidence for inspection. Cleanup failures also retain the validation evidence and
record a `cleanupError`; a passed candidate becomes `blocked` if cleanup fails,
while a rejected candidate remains `rejected`.

Isolated agent results now include `baselineOid`. For independent evaluation,
`agent()` accepts `candidatePatch: { baselineOid, patch }` with
`isolation: "worktree"`; the engine checks the fresh baseline before applying
it. Worktree isolation separates filesystem state; it is not a security sandbox.
