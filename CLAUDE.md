# CLAUDE.md — pi-workflow-engine

Guidance for working in this repo. Read the "Critical non-obvious facts" before editing.

## What this repo is

A **pi extension** that adds a multi-agent **workflow engine**: workflows authored in TypeScript fan out to many subagents, pass validated structured data between stages, and synthesise a result. It is a customisable, self-owned version of Claude Code's built-in `/code-review`. Distributed as a pi package — install with `pi install git:github.com/timbrinded/pi-workflow-engine`.

## What pi is

`pi` is a terminal coding agent (CLI/TUI) by Earendil Inc., shipped as the npm package `@earendil-works/pi-coding-agent` and run via bun. Open and extensible (Claude-Code-like). The bundled binary embeds its sibling packages: `@earendil-works/pi-ai` (models/providers), `@earendil-works/pi-agent-core` (the agent loop), `@earendil-works/pi-tui` (terminal UI), and `typebox` (schemas). Docs: https://pi.dev/docs/latest — key pages: `extensions`, `sdk`, `packages`.

## What a pi extension / package is

- **Extension**: a TypeScript module loaded at startup via [jiti] (no build step). It default-exports a factory `export default function (pi: ExtensionAPI) { ... }` that can `pi.registerTool(...)`, `pi.registerCommand(name, ...)`, subscribe to lifecycle events via `pi.on(...)`, and drive the TUI via `ctx.ui`. The SDK's `createAgentSession(...)` lets an extension spawn its own in-process agent sessions — this engine is built on that.
- **Package**: a repo whose `package.json` has a `"pi"` manifest declaring resources (`extensions`, `skills`, `prompts`, `themes`). Installed with `pi install <source>`; git sources pin to a ref. Include `keywords: ["pi-package"]` for the pi.dev gallery.

## What this extension does

`src/index.ts` registers two surfaces:
- `/workflow <name> [args]` — slash command to run a workflow.
- a `workflow` tool — lets the host agent run a workflow mid-conversation.

A **workflow** (`workflows/*.ts`) exports `meta` + a default `async (api) => result`. The injected `api`:
- `agent(prompt, { schema?, model?, thinkingLevel?, tools?, label?, phase? })` — runs one subagent; with a typebox `schema` it returns validated structured data, else final text.
- `parallel(thunks)` — concurrent; barrier (waits for all).
- `pipeline(items, ...stages)` — each item through all stages independently; no barrier between stages.
- `phase(title)` / `log(msg)` — drive the live progress tree.

Example: `workflows/code-review.ts` — Scope → per-angle Find → independent Verify → Synthesize. `workflows/ping.ts` — a one-agent smoke workflow.

## Architecture / key files

- `src/agent-runner.ts` — **the bridge**. Each `agent()` is an in-process `createAgentSession(... SessionManager.inMemory())`. Structured output = one **terminating tool** whose `parameters` IS the schema; pi validates the call, `execute` captures the args in a closure, `terminate: true` ends the turn. No event parsing.
- `src/concurrency.ts` — `Semaphore` (the single global concurrency cap, acquired inside every `agent()`), `parallel`, `pipeline`.
- `src/engine.ts` — `runWorkflow()` binds the primitives to one run (shared semaphore + progress tracker). `DEFAULT_CONCURRENCY` lives here.
- `src/progress.ts` — live phase/agent tree via `ctx.ui.setWidget`; stderr breadcrumbs when headless.
- `src/discovery.ts` + `src/workflows.ts` — static registry (`BUILTIN_WORKFLOWS`) plus best-effort dynamic drop-in loading.
- `src/types.ts` — `WorkflowApi` / `WorkflowModule` / `AgentOptions` contracts.

## Critical non-obvious facts (read before editing)

- **Core deps belong in `peerDependencies: "*"`, not `dependencies`/`devDependencies`.** pi bundles `@earendil-works/{pi-ai,pi-agent-core,pi-coding-agent,pi-tui}` and `typebox`. Local `node_modules` copies exist only so `tsc` has types.
- **At runtime, pi resolves those bare imports to its bundled copies via jiti `virtualModules`** (bun-binary mode: `virtualModules` + `tryNative:false`), intercepting before `node_modules` — so there is no dual-package hazard regardless of what's installed locally.
- **`jiti` is NOT a virtual module.** A dynamically `import()`-ed drop-in workflow may resolve a *different* `typebox` than pi's bundled one, breaking schema validation. **Therefore guaranteed workflows must be statically imported and registered in `src/workflows.ts`** (they ride pi's jiti and share its typebox). Dynamic discovery is best-effort only.
- **Set `thinkingLevel` per `agent()` stage.** Otherwise sub-agents inherit the user's global level (often `xhigh`) and a fan-out becomes very slow and expensive.
- **`pi install` runs `npm install`** (not bun). `bun.lock` is for local dev only.
- Never bundle the core packages. Never use `as any` — use typebox `Static<>` and structural narrowing.

## Local development

```bash
bun install            # installs peers + devDeps (tsc, @types/node) for typecheck
bun run typecheck      # tsc --noEmit — must be clean before commit
bun run test           # no-LLM test suite via Bun's built-in test runner
bun run test:smoke     # optional focused discovery smoke
pi -e ./src/index.ts -p "/workflow ping"   # load this working copy ephemerally
```

Add a workflow: create `workflows/<name>.ts`, import it in `src/workflows.ts`, add it to `BUILTIN_WORKFLOWS`. Customise review lenses via the `ANGLES` array in `workflows/code-review.ts`.

## How to make a release

This package ships through **three channels that must stay in lockstep**: the npm package (`npm publish`), a git **tag**, and a **GitHub Release**. `pi install git:…@vX.Y.Z` pins to the tag; `pi update` reconciles a clone to its ref. A release is only "done" when `package.json`, the git tag, npm's `latest` dist-tag, and the GitHub Release all read the same `vX.Y.Z`.

1. `bun run typecheck` and `bun run test` pass; all changes committed.
2. Bump `version` in `package.json` (semver).
3. `git commit -am "chore(release): vX.Y.Z"`
4. `git tag -a vX.Y.Z -m "vX.Y.Z"`
5. `git push origin master --follow-tags`
6. `npm publish` (runs the `prepublishOnly` typecheck). Confirm with `npm view pi-workflow-engine version`.
7. **Write release notes and publish the GitHub Release — mandatory, not optional.** Seed a bullet list from the commit range, curate it (group feat/fix/chore; drop noise like `rollback:`/scaffolding commits), then publish:
   ```bash
   git log --pretty='- %s' v<prev>..vX.Y.Z   # seed the notes
   gh release create vX.Y.Z --title vX.Y.Z --notes-file <notes.md>   # or --notes "…"
   ```
   **Do not use `--generate-notes`.** It only summarises merged PRs; this repo commits directly to `master`, so it yields nothing but a bare "Full Changelog" link (why v0.1.0–v0.2.0 read as empty). The notes must describe what changed in human terms.

**Consistency check before calling it done** — all four must match `vX.Y.Z`:
`package.json` version · `git tag -l | sort -V | tail -1` · `npm view pi-workflow-engine version` · `gh release view vX.Y.Z`.

Users pin a release with `pi install git:github.com/timbrinded/pi-workflow-engine@vX.Y.Z`; existing users run `pi update`.
