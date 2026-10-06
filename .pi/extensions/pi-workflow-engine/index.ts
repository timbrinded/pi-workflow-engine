import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { keyText, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { WorkflowProgressSnapshot } from "./src/progress-types.ts";
import { WORKFLOW_TOOL_NAME, type LoadedWorkflow, type WorkflowModule, type WorkflowProgressSource, type WorkflowRef } from "./src/types.ts";
import { WorkflowInspector } from "./src/ui/workflow-inspector.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./src/ui/workflow-viewer-layout.ts";
import type { PerfSink } from "./src/perf.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE, registerDynamax } from "./src/dynamax.ts";
import { sessionKey } from "./src/session-identity.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./src/dynamax-shortcuts.ts";
import { ReviewSessionCoordinator } from "./src/review/review-session-coordinator.ts";
import { isWorkflowResult, renderWorkflowResult, type WorkflowResultHints } from "./src/ui/workflow-result-renderer.ts";
import { renderWorkflowToolCall, renderWorkflowToolResult } from "./src/ui/workflow-tool-renderer.ts";
import {
  parseWorkflowInvocation,
  resolveWorkflowRunOptions,
  type ResolvedWorkflowRunOptions,
  WORKFLOW_AGENT_TIMEOUT_MAX_MS,
  WORKFLOW_AGENT_TIMEOUT_MIN_MS,
  WORKFLOW_AGENT_RETRIES_MAX,
  WORKFLOW_AGENT_RETRIES_MIN,
  WORKFLOW_BUDGET_MAX,
  WORKFLOW_BUDGET_MIN,
  WORKFLOW_MAX_AGENTS_MAX,
  WORKFLOW_MAX_AGENTS_MIN,
  WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
  WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
  WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
  WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
} from "./src/options.ts";
import { executeWorkflowInvocation, type WorkflowResultEnvelope } from "./src/workflow-execution.ts";
import { formatWorkflowResultForContext } from "./src/workflow-result-context.ts";
import { registerWorkflowModelProfileCommand } from "./src/model-profile-command.ts";
import { BackgroundWorkflowCoordinator } from "./src/background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./src/background-workflow-tool.ts";
import { registerWorkflowRunCommand, WorkflowRunController } from "./src/workflow-run-controller.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./src/command-completions.ts";
import { assertSupportedPiVersion } from "./src/pi-compat.ts";
import { formatWorkflowInspection, workflowInspectionSnapshot } from "./src/ui/workflow-format.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

type DiscoveryModule = typeof import("./src/discovery.ts");
type EngineModule = typeof import("./src/engine.ts");
type InlineWorkflowModule = typeof import("./src/inline-workflow.ts");

async function loadDiscovery(): Promise<DiscoveryModule> {
  return await import("./src/discovery.ts");
}

async function loadEngine(): Promise<EngineModule> {
  return await import("./src/engine.ts");
}

async function loadInlineWorkflow(): Promise<InlineWorkflowModule> {
  return await import("./src/inline-workflow.ts");
}

async function createInvocationPerf(options: ResolvedWorkflowRunOptions): Promise<PerfSink | undefined> {
  if (!options.perf) return undefined;
  const { createPerfRecorder } = await import("./src/perf.ts");
  return createPerfRecorder(true);
}

/**
 * Resolve an `api.workflow()` reference to a registered workflow module. Throws on an unknown name.
 */
export async function resolveWorkflowRef(ref: WorkflowRef, perf?: PerfSink): Promise<LoadedWorkflow> {
  const { discoverWorkflows } = await loadDiscovery();
  const workflows = await discoverWorkflows(EXTENSION_DIR, { perf });
  const mod = workflows.get(ref);
  if (!mod) {
    const available = [...workflows.keys()].join(", ") || "(none)";
    throw new Error(`Unknown workflow "${ref}". Available: ${available}`);
  }
  return mod;
}

const AUTHOR_TEMP_WORKFLOW_VALUE = "__author-temporary-workflow__";
const AUTHOR_TEMP_WORKFLOW_LABEL = "Author temporary one-shot workflow";
const AUTHOR_TEMP_WORKFLOW_DESCRIPTION = "Ask the host agent to author and run an inline workflow.";

const WORKFLOW_OPTION_COMPLETIONS = [
  { value: "--inspect", description: "Open the live workflow inspector" },
  { value: "--refresh", description: "Refresh dynamic workflow discovery" },
  { value: "--perf", description: "Collect workflow performance metrics" },
  { value: "--result-viewer", description: "Open supported result viewers" },
  { value: "--no-result-viewer", description: "Skip supported result viewers" },
  { value: "--resume-edited", description: "Allow resume after workflow source edits" },
  { value: "--concurrency=", description: "Set the global subagent concurrency cap" },
  { value: "--parallel-limit=", description: "Set the parallel submission limit" },
  { value: "--max-agents=", description: "Set the maximum admitted live agents" },
  { value: "--agent-timeout-ms=", description: "Set the timeout for each agent attempt" },
  { value: "--agent-retries=", description: "Restart an agent after pi's in-session turn retries are exhausted" },
  { value: "--budget=", description: "Set the workflow output-token budget" },
  { value: "--resume=", description: "Resume from a retained workflow run ID" },
] as const;

async function workflowArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
  const parts = splitArgumentPrefix(argumentPrefix);
  if (parts.completed.length === 0) {
    const { discoverWorkflows } = await loadDiscovery();
    const workflows = await discoverWorkflows(EXTENSION_DIR);
    return completeCurrentArgument(
      argumentPrefix,
      [...workflows.values()].map((workflow) => ({
        value: workflow.meta.name,
        description: workflow.meta.description,
      })),
    );
  }
  return completeCurrentArgument(argumentPrefix, WORKFLOW_OPTION_COMPLETIONS);
}

async function selectWorkflowValue(workflows: ReadonlyMap<string, WorkflowModule>, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const choices = [
    {
      value: AUTHOR_TEMP_WORKFLOW_VALUE,
      display: `${AUTHOR_TEMP_WORKFLOW_LABEL} — ${AUTHOR_TEMP_WORKFLOW_DESCRIPTION}`,
    },
    ...[...workflows.values()].map((workflow) => ({
      value: workflow.meta.name,
      display: `${workflow.meta.name} — ${workflow.meta.description}`,
    })),
  ];
  const selected = await ctx.ui.select(
    "Run workflow",
    choices.map((choice) => choice.display),
  );
  return choices.find((choice) => choice.display === selected)?.value;
}

export interface LastWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly completedAt: number;
  readonly snapshot: WorkflowProgressSnapshot;
}

export interface ActiveWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  readonly snapshot: () => WorkflowProgressSnapshot;
}

interface SessionWorkflowInspections {
  last?: LastWorkflowInspection;
  active?: ActiveWorkflowInspection;
}

const workflowInspections = new WeakMap<ExtensionAPI, Map<string, SessionWorkflowInspections>>();

export async function openWorkflowInspector(ctx: ExtensionContext, inspection: LastWorkflowInspection | ActiveWorkflowInspection): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify(formatWorkflowInspection(inspection), "info");
    return;
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WorkflowInspector(() => workflowInspectionSnapshot(inspection), tui, theme, () => done(undefined)),
    WORKFLOW_VIEWER_OVERLAY_OPTIONS,
  );
}

function workflowInspectionState(pi: ExtensionAPI, ctx: ExtensionContext): SessionWorkflowInspections {
  const sessions = workflowInspections.get(pi) ?? new Map<string, SessionWorkflowInspections>();
  const key = sessionKey(ctx);
  const state = sessions.get(key) ?? {};
  sessions.set(key, state);
  workflowInspections.set(pi, sessions);
  return state;
}

async function openAvailableWorkflowInspector(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const state = workflowInspectionState(pi, ctx);
  const inspection = state.active ?? state.last;
  if (!inspection) {
    ctx.ui.notify("No workflow inspector is available yet", "warning");
    return;
  }
  await openWorkflowInspector(ctx, inspection);
}

function bindActiveWorkflowInspection(name: string, args: string, source: WorkflowProgressSource): ActiveWorkflowInspection {
  return { name, args, startedAt: Date.now(), snapshot: () => source.snapshot() };
}

export function buildTemporaryWorkflowAuthorPrompt(brief: string): string {
  return `dynamax author and run a temporary one-shot inline workflow.

User brief:
${brief.trim()}

Use the workflow tool with a script argument, not a saved workflow name.
The script must start with export const meta = { ... } and default-export an async workflow function.
Use the injected Type object for schemas. Do not import anything or use dynamic import().
Set profile to "small", "medium", or "big" on each agent() call; use explicit model/thinkingLevel only for an intentional override.
Always pass a plain string as the first api.agent() argument; build prompts with template strings before calling agent().
If using \`isolation: "worktree"\`, remember api.agent() returns \`{ result, patch, changed }\`; read \`.result\` for the agent answer and \`.patch\` for the diff.
When the run is budgeted, guard expensive loops with \`while (api.budget.total && api.budget.remaining() > N) { ... }\`; api.agent() throws once the budget is spent.
Subagents receive no skills by default. When the brief asks for a skill or a stage clearly benefits from one, pass \`skills: ["skill-name"]\` on that agent call only.
${ADAPTIVE_WORKFLOW_GUIDANCE}
Do not edit files unless the user explicitly requested edits.`;
}

export interface WorkflowToolRequestParams {
  readonly name?: string;
  readonly script?: string;
  readonly resumeFromRunId?: string;
  readonly background?: boolean;
}

export type WorkflowToolRequest =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "inline"; readonly script: string }
  | { readonly kind: "error"; readonly error: "invalid_workflow_invocation"; readonly message: string };

export interface WorkflowToolErrorResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: { readonly error: "invalid_workflow_invocation" } | { readonly error: "inline_compile_error"; readonly message: string };
}

const INVALID_WORKFLOW_INVOCATION_MESSAGE = "Provide exactly one workflow name or inline workflow script.";

export function normalizeWorkflowToolRequest(params: WorkflowToolRequestParams): WorkflowToolRequest {
  const name = params.name?.trim() ?? "";
  const script = params.script?.trim() ?? "";
  const hasName = name.length > 0;
  const hasScript = script.length > 0;
  if (hasName === hasScript) return { kind: "error", error: "invalid_workflow_invocation", message: INVALID_WORKFLOW_INVOCATION_MESSAGE };
  return hasName ? { kind: "named", name } : { kind: "inline", script };
}

export function invalidWorkflowInvocationResult(): WorkflowToolErrorResult {
  return { content: [{ type: "text", text: INVALID_WORKFLOW_INVOCATION_MESSAGE }], details: { error: "invalid_workflow_invocation" } };
}

export function inlineCompileErrorResult(message: string): WorkflowToolErrorResult {
  return { content: [{ type: "text", text: `Inline workflow did not compile: ${message}` }], details: { error: "inline_compile_error", message } };
}

export type WorkflowPickerSelection =
  | { readonly kind: "run"; readonly name: string; readonly args: string }
  | { readonly kind: "author"; readonly brief: string };

export async function pickWorkflow(
  workflows: ReadonlyMap<string, WorkflowModule>,
  ctx: ExtensionCommandContext,
): Promise<WorkflowPickerSelection | undefined> {
  const name = await selectWorkflowValue(workflows, ctx);
  if (!name) return undefined;

  if (name === AUTHOR_TEMP_WORKFLOW_VALUE) {
    const brief = await ctx.ui.editor(
      "Describe temporary workflow",
      "Goal:\n\nAgents to run:\n- \n\nFinal output should include:\n- summary\n- findings\n- next steps\n",
    );
    const trimmed = brief?.trim();
    return trimmed ? { kind: "author", brief: trimmed } : undefined;
  }

  if (name !== "code-review") return { kind: "run", name, args: "" };
  // Escape resolves undefined and cancels; only a submitted blank target means auto-detect.
  const target = await ctx.ui.input("Code-review target/instructions", "Blank = auto-detect diff");
  return target === undefined ? undefined : { kind: "run", name, args: target.trim() };
}

export async function sendWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
  reviewSessions: ReviewSessionCoordinator = createReviewSessionCoordinator(pi),
): Promise<void> {
  const envelope = await executeResolvedWorkflow(pi, ctx, name, mod, args, options, perfRecorder);
  const retained = reviewSessions.remember(ctx, envelope, options);
  publishWorkflowResult(pi, envelope);
  await reviewSessions.present(ctx, retained, options);
}

async function executeResolvedWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<WorkflowResultEnvelope> {
  const { runResolvedWorkflow } = await loadEngine();
  let liveInspection: ActiveWorkflowInspection | undefined;
  const inspections = workflowInspectionState(pi, ctx);
  return await executeWorkflowInvocation({
    ctx,
    name,
    mod,
    args,
    options,
    perfRecorder,
    runResolvedWorkflow,
    resolveWorkflow: (ref) => resolveWorkflowRef(ref, perfRecorder),
    onProgressSource(source) {
      if (source) {
        liveInspection = bindActiveWorkflowInspection(name, args, source);
        inspections.active = liveInspection;
      } else if (inspections.active === liveInspection) {
        inspections.active = undefined;
        liveInspection = undefined;
      }
    },
    onProgressSnapshot(snapshot) {
      inspections.last = { name, args, completedAt: snapshot.doneAt ?? Date.now(), snapshot };
    },
  });
}

function publishWorkflowResult(pi: ExtensionAPI, envelope: WorkflowResultEnvelope): void {
  pi.sendMessage(
    {
      customType: "workflow-result",
      content: formatWorkflowResultForContext(envelope),
      display: true,
      details: envelope,
    },
    { triggerTurn: false },
  );
}

function createReviewSessionCoordinator(pi: ExtensionAPI): ReviewSessionCoordinator {
  return new ReviewSessionCoordinator(pi, {
    async runFollowUp(ctx, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      return await executeResolvedWorkflow(pi, ctx, workflow.meta.name, workflow, "", options, perfRecorder);
    },
    publish: (envelope) => publishWorkflowResult(pi, envelope),
  });
}

export default function workflowEngine(pi: ExtensionAPI, shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts()): void {
  assertSupportedPiVersion(VERSION);
  const reviewSessions = createReviewSessionCoordinator(pi);
  const backgroundWorkflows = new BackgroundWorkflowCoordinator(pi);
  const workflowRuns = new WorkflowRunController(backgroundWorkflows, {
    async resolveWorkflow(name) {
      const { discoverWorkflows } = await loadDiscovery();
      return (await discoverWorkflows(EXTENSION_DIR)).get(name);
    },
    async execute(ctx, name, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      const envelope = await executeResolvedWorkflow(pi, ctx, name, workflow, "", options, perfRecorder);
      reviewSessions.remember(ctx, envelope, options);
    },
  });
  backgroundWorkflows.onRunSettled((ctx, runId) => workflowRuns.runSettled(ctx, runId));
  const dynamax = registerDynamax(pi, shortcuts, { openInspector: (ctx) => openAvailableWorkflowInspector(pi, ctx) });
  registerWorkflowModelProfileCommand(pi);
  registerWorkflowRunCommand(pi, workflowRuns);
  pi.on("session_start", async (_event, ctx) => {
    await backgroundWorkflows.sessionStarted(ctx);
    await workflowRuns.sessionStarted(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await backgroundWorkflows.agentSettled(ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    workflowRuns.sessionShutdown(ctx);
    await backgroundWorkflows.sessionShutdown(ctx);
    const key = sessionKey(ctx);
    workflowInspections.get(pi)?.delete(key);
    reviewSessions.dispose(ctx);
  });
  if (shortcuts.results) {
    pi.registerShortcut(shortcuts.results, {
      description: "Open last code-review results",
      handler: async (ctx) => {
        await reviewSessions.reopen(ctx);
      },
    });
  }

  pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) => {
    const details = message.details;
    const view = isWorkflowResult(details) ? details : { name: "workflow", result: details ?? message.content };
    return renderWorkflowResult(view, expanded, theme, workflowResultHints(shortcuts));
  });

  pi.registerCommand("workflow:inspector", {
    description: "Open the current, last, or a retained run inspector",
    getArgumentCompletions: (argumentPrefix) => workflowRuns.inspectorArgumentCompletions(argumentPrefix),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (trimmed && trimmed !== "last") {
        if (await workflowRuns.inspectStoredRun(ctx, trimmed)) return;
        ctx.ui.notify(`Workflow run ${trimmed} was not found.`, "warning");
        return;
      }
      await openAvailableWorkflowInspector(pi, ctx);
    },
  });

  pi.registerCommand("workflow:results", {
    description: "Reopen the last code-review findings viewer",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /workflow:results", "warning");
        return;
      }
      await reviewSessions.reopen(ctx);
    },
  });

  // /workflow <name> [args] — user-invoked.
  pi.registerCommand("workflow", {
    description: "Run a multi-agent workflow: /workflow <name> [args]",
    getArgumentCompletions: workflowArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const invocation = parseWorkflowInvocation(args);
      if (invocation.optionErrors.length > 0) {
        ctx.ui.notify(`Invalid workflow option: ${invocation.optionErrors.join("; ")}`, "warning");
        return;
      }
      const options = resolveWorkflowRunOptions(invocation.options);
      const perfRecorder = await createInvocationPerf(options);
      const { discoverWorkflows } = await loadDiscovery();
      const workflows = await discoverWorkflows(EXTENSION_DIR, { refresh: invocation.refreshDiscovery, perf: perfRecorder });
      const available = [...workflows.keys()].join(", ") || "(none)";
      const selection: WorkflowPickerSelection | undefined = invocation.name
        ? { kind: "run", name: invocation.name, args: invocation.args }
        : ctx.hasUI ? await pickWorkflow(workflows, ctx) : undefined;

      if (!selection) {
        ctx.ui.notify(`Usage: /workflow <name> [args]. Available: ${available}`, "warning");
        return;
      }

      if (selection.kind === "author") {
        // A send while the agent streams is rejected, which would leave the one-shot armed for an unrelated prompt.
        await ctx.waitForIdle();
        dynamax.markOneShot(ctx);
        pi.sendUserMessage(buildTemporaryWorkflowAuthorPrompt(selection.brief));
        return;
      }

      const mod = workflows.get(selection.name);
      if (!mod) {
        ctx.ui.notify(`Unknown workflow "${selection.name}". Available: ${available}`, "error");
        return;
      }

      await sendWorkflowResult(pi, ctx, selection.name, mod, selection.args, options, perfRecorder, reviewSessions);
    },
  });

  registerWorkflowTool(pi, reviewSessions, backgroundWorkflows, shortcuts);
}

/** Result footers advertise the configured triage shortcut and pi's current expand key, read at render time. */
function workflowResultHints(shortcuts: DynamaxShortcuts): WorkflowResultHints {
  return { triage: shortcuts.results ?? "/workflow:results", expand: keyText("app.tools.expand") || undefined };
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
function registerWorkflowTool(
  pi: ExtensionAPI,
  reviewSessions: ReviewSessionCoordinator,
  backgroundWorkflows: BackgroundWorkflowCoordinator,
  shortcuts: DynamaxShortcuts,
): void {
  pi.registerTool({
    name: WORKFLOW_TOOL_NAME,
    label: "Workflow",
    description:
      "ONLY call workflow when the user opted into multi-agent orchestration via the literal token `dynamax`, sticky `/workflow:dynamax on`, an explicit request to run or author a workflow, or a command/skill instruction. Runs either a registered named workflow or an inline one-off workflow script (fan-out → verify → synthesize), synchronously by default or explicitly in the background.",
    promptSnippet: "Run an existing named workflow or an inline one-off workflow script",
    promptGuidelines: [
      "Use workflow only when the user opted into workflow orchestration via `dynamax`, `/workflow:dynamax on`, an explicit request to run/author a workflow, or a command/skill instruction.",
      "Use workflow with `name` for existing registered workflows such as code-review, diagnose, refactor-scout, or perf-review.",
      "Use workflow with `script` for a new one-off inline workflow; the script must start with `export const meta = { ... }` and default-export an async workflow function.",
      "Inline workflow scripts must use the injected `Type` object for schemas and must not contain imports or dynamic import().",
      "Inline scripts may compose registered workflows in-process via `api.workflow(\"<name>\", args)` (e.g. `await api.workflow(\"code-review\", \"HEAD~3\")`); it returns the sub-workflow's result and nests one level only.",
      "Subagents receive no skills by default. In inline workflows, pass `skills: [\"skill-name\"]` per `agent()` call when the user asks for a skill or a stage should use one; grant only the needed skills.",
      "Always pass a plain string as the first `api.agent()` argument; build prompts with template strings before calling agent().",
      "When using `isolation: \"worktree\"`, `api.agent()` returns `{ result, patch, changed }`; use `.result` for the answer and `.patch` for the isolated diff.",
      "If an inline subagent needs grep/find/code-search helpers, use `tools: [\"read\", \"bash\", \"grep\", \"find\", \"ls\"]` plus `toolHints: [\"search\"]` so installed tools such as ast-grep, mgrep, ffgrep, or fffind are discovered dynamically.",
      "`api.budget` exposes `{ total, spent(), remaining() }` (output tokens). When the run is budgeted, scale fleets from `budget.total` and guard loops with `while (budget.total && budget.remaining() > N) { await api.agent(...) }`; `api.agent()` throws once the ceiling is reached.",
      ADAPTIVE_WORKFLOW_GUIDANCE,
      "Set background: true only when the user explicitly wants the workflow to continue after this tool call; the tool returns a durable run ID and completion is delivered later.",
      "Set autoResumeOnUsageLimit: true only for an explicitly backgrounded workflow when the user wants bounded automatic continuation after a recognized provider usage window.",
      "Set resumeEditedWorkflow: true only with resumeFromRunId when the user explicitly accepts reusing behaviorally identical calls after workflow source edits.",
      "Every workflow tool call must provide exactly one of `name` or `script`, never both.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Workflow name, e.g. code-review. Provide exactly one of name or script." })),
      script: Type.Optional(Type.String({ description: "Inline workflow script. Provide exactly one of script or name." })),
      args: Type.Optional(Type.String({ description: "Arguments for the workflow (e.g. target or focus)" })),
      concurrency: Type.Optional(Type.Number({ description: "Optional per-run agent concurrency cap" })),
      parallelSubmissionLimit: Type.Optional(Type.Number({ description: "Optional limit for eagerly submitted parallel thunks" })),
      maxAgents: Type.Optional(
        Type.Integer({
          description: `Maximum live model calls started across this run; replay hits are excluded; clamped to ${WORKFLOW_MAX_AGENTS_MIN}-${WORKFLOW_MAX_AGENTS_MAX}`,
        }),
      ),
      agentTimeoutMs: Type.Optional(
        Type.Integer({
          description: `Maximum live duration per agent in milliseconds; clamped to ${WORKFLOW_AGENT_TIMEOUT_MIN_MS}-${WORKFLOW_AGENT_TIMEOUT_MAX_MS}`,
        }),
      ),
      agentRetries: Type.Optional(
        Type.Integer({
          description: `Whole-agent restarts after a transient provider failure that pi's in-session turn retry (the user's pi retry settings) could not recover; clamped to ${WORKFLOW_AGENT_RETRIES_MIN}-${WORKFLOW_AGENT_RETRIES_MAX}`,
        }),
      ),
      autoResumeOnUsageLimit: Type.Optional(
        Type.Boolean({ description: "For a background run, opt into bounded automatic resume after a recognized provider usage limit" }),
      ),
      usageLimitMaxAttempts: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
          maximum: WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
          description: "Maximum total run attempts in one automatic provider-limit resume chain",
        }),
      ),
      usageLimitMaxDelayMs: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
          maximum: WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
          description: "Maximum delay accepted from a provider reset hint before automatic resume",
        }),
      ),
      budget: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_BUDGET_MIN,
          maximum: WORKFLOW_BUDGET_MAX,
          description: "Optional output-token ceiling for the run; agent() throws once it is exceeded",
        }),
      ),
      perf: Type.Optional(Type.Boolean({ description: "Include workflow performance timing aggregates in the result details" })),
      resumeFromRunId: Type.Optional(Type.String({ minLength: 1, description: "Workflow run id to resume from by replaying matching completed agent results" })),
      resumeEditedWorkflow: Type.Optional(
        Type.Boolean({ description: "With resumeFromRunId, ignore only workflow-source fingerprint changes while retaining all other replay checks" }),
      ),
      background: Type.Optional(Type.Boolean({ description: "Return a durable run ID immediately and deliver completion to this conversation later" })),
    }),
    renderCall(args, theme) {
      return renderWorkflowToolCall(args, theme);
    },
    renderResult(result, options, theme, context) {
      return renderWorkflowToolResult(result, options, theme, context.args, workflowResultHints(shortcuts));
    },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const request = normalizeWorkflowToolRequest(params);
      if (request.kind === "error") return invalidWorkflowInvocationResult();
      const resumeFromRunId = params.resumeFromRunId?.trim();
      if (params.resumeFromRunId !== undefined && resumeFromRunId === "") {
        return {
          content: [{ type: "text", text: "resumeFromRunId must be non-empty." }],
          details: { error: "invalid_resume_from_run_id" },
        };
      }
      if (params.resumeEditedWorkflow && !resumeFromRunId) {
        return {
          content: [{ type: "text", text: "resumeEditedWorkflow requires resumeFromRunId." }],
          details: { error: "invalid_edited_workflow_resume" },
        };
      }
      if (params.background) {
        const unavailable = backgroundUnavailableResult(ctx.mode);
        if (unavailable) return unavailable;
      }

      const runOptions = resolveWorkflowRunOptions({
        inspect: ctx.hasUI && ctx.mode === "tui",
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        maxAgents: params.maxAgents,
        agentTimeoutMs: params.agentTimeoutMs,
        agentRetries: params.agentRetries,
        autoResumeOnUsageLimit: params.autoResumeOnUsageLimit,
        usageLimitMaxAttempts: params.usageLimitMaxAttempts,
        usageLimitMaxDelayMs: params.usageLimitMaxDelayMs,
        budget: params.budget,
        perf: params.perf,
        resumeFromRunId,
        resumeEditedWorkflow: params.resumeEditedWorkflow,
        signal,
      });
      const perfRecorder = await createInvocationPerf(runOptions);
      let mod: LoadedWorkflow;
      let resultName: string;

      if (request.kind === "named") {
        const { discoverWorkflows } = await loadDiscovery();
        const workflows = await discoverWorkflows(EXTENSION_DIR, { perf: perfRecorder });
        const named = workflows.get(request.name);
        if (!named) {
          const available = [...workflows.keys()].join(", ") || "(none)";
          return {
            content: [{ type: "text", text: `Unknown workflow "${request.name}". Available: ${available}` }],
            details: { error: "unknown_workflow", available },
          };
        }
        mod = named;
        resultName = request.name;
      } else {
        const inline = await loadInlineWorkflow();
        try {
          mod = inline.compileInlineWorkflow(request.script);
        } catch (error) {
          if (error instanceof inline.InlineWorkflowCompileError) return inlineCompileErrorResult(error.message);
          throw error;
        }
        resultName = mod.meta.name;
      }

      const resultArgs = params.args ?? "";
      if (params.background) {
        return await startBackgroundWorkflowTool({
          coordinator: backgroundWorkflows,
          ctx,
          name: resultName,
          options: runOptions,
          async execute(backgroundCtx, backgroundOptions) {
            const envelope = await executeResolvedWorkflow(
              pi,
              backgroundCtx,
              resultName,
              mod,
              resultArgs,
              backgroundOptions,
              perfRecorder,
            );
            reviewSessions.remember(ctx, envelope, backgroundOptions);
          },
        });
      }
      // Marks the tool row as running (rendered `● running <name>`) until the envelope replaces it.
      onUpdate?.({ content: [{ type: "text", text: `Running workflow ${resultName}.` }], details: { state: "running", name: resultName } });
      const envelope = await executeResolvedWorkflow(pi, ctx, resultName, mod, resultArgs, runOptions, perfRecorder);
      reviewSessions.remember(ctx, envelope, runOptions);
      return {
        content: [{ type: "text", text: formatWorkflowResultForContext(envelope) }],
        details: envelope,
      };
    },
  });
}
