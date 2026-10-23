import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { getSelectListTheme, keyText, VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, SelectItem } from "@earendil-works/pi-tui";
import type { WorkflowProgressSnapshot } from "./src/progress-types.ts";
import type { WorkflowRunState } from "./src/workflow-run-record.ts";
import {
  WORKFLOW_TOOL_NAME,
  type LoadedWorkflow,
  type WorkflowModule,
  type WorkflowProgressSource,
  type WorkflowRef,
  type WorkflowRunMetadata,
} from "./src/types.ts";
import { showWorkflowInspector } from "./src/ui/workflow-inspector.ts";
import { WorkflowPicker } from "./src/ui/workflow-picker.ts";
import type { PerfSink } from "./src/perf.ts";
import type { DiscoverWorkflowsOptions } from "./src/discovery.ts";
import { registerDynamax, resolveTurnBudget, type DynamaxHandle } from "./src/dynamax.ts";
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
import { formatWorkflowResultForContext, formatWorkflowRunFileLines, formatWorkflowRunLine } from "./src/workflow-result-context.ts";
import { registerWorkflowModelProfileCommand } from "./src/model-profile-command.ts";
import { BackgroundWorkflowCoordinator } from "./src/background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./src/background-workflow-tool.ts";
import { registerWorkflowRunCommand, WorkflowRunController } from "./src/workflow-run-controller.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./src/command-completions.ts";
import { assertSupportedPiVersion } from "./src/pi-compat.ts";
import { formatWorkflowInspection, workflowInspectionSnapshot } from "./src/ui/workflow-format.ts";
import { workflowUsageForPi, type WorkflowUsageSnapshot } from "./src/usage.ts";
import { unknownErrorMessage } from "./src/unknown-error.ts";
import { createHostToolBridge } from "./src/host-tools.ts";
import { appendSectionToForcedPrompt } from "./src/prompt-sections.ts";
import { WORKFLOWS_SECTION, WorkflowCatalogPrompt } from "./src/workflow-catalog.ts";
import { registerWorkflowSizeCommand, resolveWorkflowSize, workflowSettingsPaths } from "./src/workflow-settings.ts";
import { isRecord } from "./src/guards.ts";
import { INVALID_WORKFLOW_INVOCATION_MESSAGE, normalizeWorkflowToolRequest, workflowToolReach } from "./src/workflow-tool-request.ts";
import { workflowArgsText } from "./src/workflow-input.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));
/** The package's authoring skill, named by path so the guideline still resolves when skills are filtered out. */
const WORKFLOW_AUTHORING_SKILL_PATH = fileURLToPath(new URL("../../../skills/workflow-authoring/SKILL.md", import.meta.url));

type DiscoveryModule = typeof import("./src/discovery.ts");
type EngineModule = typeof import("./src/engine.ts");
type InlineWorkflowModule = typeof import("./src/inline-workflow.ts");
type WorkflowScriptFileModule = typeof import("./src/workflow-script-file.ts");

async function loadDiscovery(): Promise<DiscoveryModule> {
  return await import("./src/discovery.ts");
}

async function loadEngine(): Promise<EngineModule> {
  return await import("./src/engine.ts");
}

async function loadInlineWorkflow(): Promise<InlineWorkflowModule> {
  return await import("./src/inline-workflow.ts");
}

async function loadWorkflowScriptFile(): Promise<WorkflowScriptFileModule> {
  return await import("./src/workflow-script-file.ts");
}

async function createInvocationPerf(options: ResolvedWorkflowRunOptions): Promise<PerfSink | undefined> {
  if (!options.perf) return undefined;
  const { createPerfRecorder } = await import("./src/perf.ts");
  return createPerfRecorder(true);
}

/** What workflow discovery reads from a session: its cwd, and whether its project's saved scripts may load. */
export type WorkflowDiscoveryContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;

/** Project `.pi/workflows` scripts load only in a project pi trusts, like pi's own project resources. */
function projectWorkflowDir(ctx: WorkflowDiscoveryContext): string | undefined {
  return ctx.isProjectTrusted() ? ctx.cwd : undefined;
}

/** Every workflow a session can run, with the project-trust gate applied in this one place. */
async function discoverForSession(
  ctx: WorkflowDiscoveryContext,
  options: Omit<DiscoverWorkflowsOptions, "projectDir"> = {},
): Promise<Map<string, LoadedWorkflow>> {
  const { discoverWorkflows } = await loadDiscovery();
  return await discoverWorkflows(EXTENSION_DIR, { ...options, projectDir: projectWorkflowDir(ctx) });
}

/**
 * Resolve an `api.workflow()` reference: a registered workflow by name, or an inline-format script file
 * via `{ scriptPath }` relative to the cwd. Throws on an unknown name, an unreadable scriptPath, or a
 * compile error.
 */
export async function resolveWorkflowRef(ctx: WorkflowDiscoveryContext, ref: WorkflowRef, perf?: PerfSink): Promise<LoadedWorkflow> {
  if (typeof ref !== "string") {
    // Inline scripts are untyped, so check the shape the type promises.
    const scriptPath: unknown = isRecord(ref) ? ref.scriptPath : undefined;
    if (typeof scriptPath !== "string") throw new Error("workflow() expects a workflow name or { scriptPath }");
    const { compileWorkflowScriptFile } = await loadWorkflowScriptFile();
    return await compileWorkflowScriptFile(ctx.cwd, scriptPath);
  }
  const workflows = await discoverForSession(ctx, { perf });
  const mod = workflows.get(ref);
  if (!mod) {
    const available = [...workflows.keys()].join(", ") || "(none)";
    throw new Error(`Unknown workflow "${ref}". Available: ${available}`);
  }
  return mod;
}

const AUTHOR_TEMP_WORKFLOW_VALUE = "__author-temporary-workflow__";
const AUTHOR_TEMP_WORKFLOW_LABEL = "+ author a one-off workflow";
const AUTHOR_TEMP_WORKFLOW_DESCRIPTION = "Ask the host agent to author and run an inline workflow.";

const WORKFLOW_OPTION_COMPLETIONS = [
  { value: "--inspect", description: "Open the live workflow inspector" },
  { value: "--refresh", description: "Reload .ts drop-in workflows" },
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

/** Completions get no context, so the project's scripts come from the active session's tracked dir. */
async function workflowArgumentCompletions(argumentPrefix: string, projectDir: string | undefined): Promise<AutocompleteItem[] | null> {
  const parts = splitArgumentPrefix(argumentPrefix);
  if (parts.completed.length === 0) {
    const { discoverWorkflows } = await loadDiscovery();
    const workflows = await discoverWorkflows(EXTENSION_DIR, { projectDir });
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

/**
 * The active session's trusted project dir, kept for surfaces pi calls without a context. Session
 * replacement invalidates a context, so only this value is kept.
 */
function trackProjectWorkflowDir(pi: ExtensionAPI): () => string | undefined {
  let projectDir: string | undefined;
  pi.on("session_start", (_event, ctx) => {
    projectDir = projectWorkflowDir(ctx);
  });
  pi.on("session_shutdown", () => {
    projectDir = undefined;
  });
  return () => projectDir;
}

/** Registered workflows in discovery order (built-ins first), then the author option. */
async function selectWorkflowValue(workflows: ReadonlyMap<string, WorkflowModule>, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const workflowItems: SelectItem[] = [...workflows.values()].map((workflow) => ({
    value: workflow.meta.name,
    label: workflow.meta.name,
    description: workflow.meta.description,
  }));
  if (ctx.mode === "tui") {
    const items = [...workflowItems, { value: AUTHOR_TEMP_WORKFLOW_VALUE, label: AUTHOR_TEMP_WORKFLOW_LABEL }];
    return await ctx.ui.custom<string | undefined>((...[, theme, , done]) => new WorkflowPicker(items, theme, getSelectListTheme(), done));
  }
  const choices = [
    ...workflowItems.map((item) => ({ value: item.value, display: `${item.label} — ${item.description}` })),
    { value: AUTHOR_TEMP_WORKFLOW_VALUE, display: `${AUTHOR_TEMP_WORKFLOW_LABEL} — ${AUTHOR_TEMP_WORKFLOW_DESCRIPTION}` },
  ];
  const selected = await ctx.ui.select("Run a workflow", choices.map((choice) => choice.display));
  return choices.find((choice) => choice.display === selected)?.value;
}

export interface LastWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly completedAt: number;
  readonly snapshot: WorkflowProgressSnapshot;
  readonly state?: () => WorkflowRunState;
}

export interface ActiveWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly startedAt: number;
  readonly snapshot: () => WorkflowProgressSnapshot;
  readonly state?: () => WorkflowRunState;
  readonly skipAgent?: (agentId: number) => boolean;
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
  // Only a live inspection can skip agents; a finished one is a snapshot.
  const controls = "skipAgent" in inspection ? { skipAgent: inspection.skipAgent } : undefined;
  await showWorkflowInspector(ctx.ui, () => workflowInspectionSnapshot(inspection), () => ({ state: inspection.state?.() }), controls);
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
  return { name, args, startedAt: Date.now(), snapshot: () => source.snapshot(), state: source.state, skipAgent: source.skipAgent };
}

export function buildTemporaryWorkflowAuthorPrompt(brief: string): string {
  return `dynamax author and run a temporary one-shot inline workflow.

User brief:
${brief.trim()}

Use the workflow tool with a script argument, not a saved workflow name, and read the workflow-authoring skill before writing the script.
Do not edit files unless the user explicitly requested edits.`;
}

export interface WorkflowToolErrorResult<TDetails = WorkflowToolErrorDetails> {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: TDetails;
  /** The model sees a failed call while the renderer still reads `details`. */
  readonly isError: true;
}

type WorkflowToolErrorDetails =
  | { readonly error: "invalid_workflow_invocation" }
  | { readonly error: "inline_compile_error"; readonly message: string }
  | { readonly error: "invalid_script_path"; readonly message: string };

function workflowToolError<TDetails>(text: string, details: TDetails): WorkflowToolErrorResult<TDetails> {
  return { content: [{ type: "text", text }], details, isError: true };
}

export function invalidWorkflowInvocationResult(): WorkflowToolErrorResult {
  return workflowToolError(INVALID_WORKFLOW_INVOCATION_MESSAGE, { error: "invalid_workflow_invocation" });
}

export function inlineCompileErrorResult(message: string): WorkflowToolErrorResult {
  return workflowToolError(`Inline workflow did not compile: ${message}`, { error: "inline_compile_error", message });
}

function invalidScriptPathResult(message: string): WorkflowToolErrorResult {
  return workflowToolError(message, { error: "invalid_script_path", message });
}

/** Compile the tool's inline `script` or `scriptPath` file, shaping contract failures as tool errors. */
async function compileInlineToolWorkflow(
  cwd: string,
  request: { readonly kind: "inline"; readonly script: string } | { readonly kind: "script-path"; readonly scriptPath: string },
): Promise<LoadedWorkflow | WorkflowToolErrorResult> {
  const [inline, scriptFile] = await Promise.all([loadInlineWorkflow(), loadWorkflowScriptFile()]);
  try {
    return request.kind === "inline"
      ? inline.compileInlineWorkflow(request.script)
      : await scriptFile.compileWorkflowScriptFile(cwd, request.scriptPath);
  } catch (error) {
    if (error instanceof scriptFile.WorkflowScriptPathError) return invalidScriptPathResult(error.message);
    if (error instanceof inline.InlineWorkflowCompileError) return inlineCompileErrorResult(error.message);
    throw error;
  }
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

/** `input` is a slash command's argument string, or a tool call's string or JSON value. */
async function executeResolvedWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  input: unknown,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<WorkflowResultEnvelope> {
  const { runResolvedWorkflow } = await loadEngine();
  let liveInspection: ActiveWorkflowInspection | undefined;
  const inspections = workflowInspectionState(pi, ctx);
  const args = workflowArgsText(input);
  return await executeWorkflowInvocation({
    ctx,
    name,
    mod,
    args: input,
    options,
    perfRecorder,
    runResolvedWorkflow,
    resolveWorkflow: (ref) => resolveWorkflowRef(ctx, ref, perfRecorder),
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
      // The durable state settles after this final snapshot; keep reading it from the live source.
      inspections.last = { name, args, completedAt: snapshot.doneAt ?? Date.now(), snapshot, state: liveInspection?.state };
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
  const sessionProjectDir = trackProjectWorkflowDir(pi);
  const workflowRuns = new WorkflowRunController(backgroundWorkflows, {
    async resolveWorkflow(name, ctx) {
      return (await discoverForSession(ctx)).get(name);
    },
    async execute(ctx, name, workflow, options) {
      const perfRecorder = await createInvocationPerf(options);
      const envelope = await executeResolvedWorkflow(pi, ctx, name, workflow, "", options, perfRecorder);
      reviewSessions.remember(ctx, envelope, options);
    },
  });
  backgroundWorkflows.onRunSettled((ctx, runId) => workflowRuns.runSettled(ctx, runId));
  const workflowCatalog = new WorkflowCatalogPrompt({
    async discover(ctx) {
      return [...(await discoverForSession(ctx)).values()].map((workflow) => workflow.meta);
    },
    size: (ctx) => resolveWorkflowSize(workflowSettingsPaths(ctx.cwd)).size,
  });
  // Before Dynamax, so the stable catalog section precedes the per-turn opt-in section.
  registerWorkflowCatalog(pi, workflowCatalog);
  registerWorkflowSizeCommand(pi, (ctx) => workflowCatalog.forget(ctx));
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
    getArgumentCompletions: (argumentPrefix) => workflowArgumentCompletions(argumentPrefix, sessionProjectDir()),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const invocation = parseWorkflowInvocation(args);
      if (invocation.optionErrors.length > 0) {
        ctx.ui.notify(`Invalid workflow option: ${invocation.optionErrors.join("; ")}`, "warning");
        return;
      }
      const options = resolveWorkflowRunOptions(invocation.options);
      const perfRecorder = await createInvocationPerf(options);
      const workflows = await discoverForSession(ctx, { refresh: invocation.refreshDiscovery, perf: perfRecorder });
      const available = [...workflows.keys()].join(", ") || "(none)";
      if (!invocation.name && !ctx.hasUI) {
        ctx.ui.notify(`Usage: /workflow <name> [args]. Available: ${available}`, "warning");
        return;
      }
      const selection: WorkflowPickerSelection | undefined = invocation.name
        ? { kind: "run", name: invocation.name, args: invocation.args }
        : await pickWorkflow(workflows, ctx);
      // Dismissing the picker or one of its follow-up prompts is a deliberate cancel, not a usage error.
      if (!selection) return;

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

  registerWorkflowTool(pi, reviewSessions, backgroundWorkflows, shortcuts, dynamax);
}

/** Add the `<workflows>` catalog to every run that can call the workflow tool. */
function registerWorkflowCatalog(pi: ExtensionAPI, catalog: WorkflowCatalogPrompt): void {
  pi.on("session_start", (_event, ctx) => catalog.forget(ctx));
  pi.on("session_shutdown", (_event, ctx) => catalog.forget(ctx));
  pi.on("before_agent_start", async (event, ctx) => {
    const options = event.systemPromptOptions;
    // Subagent sessions withhold the workflow tool, so they skip the catalog as well.
    if (!options.selectedTools.includes(WORKFLOW_TOOL_NAME)) return undefined;
    const text = await catalog.section(ctx);
    if (text === undefined) return undefined;
    options.sections[WORKFLOWS_SECTION] = text;
    return appendSectionToForcedPrompt(options, WORKFLOWS_SECTION);
  });
}

/** Result footers advertise the configured triage and inspector shortcuts and pi's current expand key, read at render time. */
function workflowResultHints(shortcuts: DynamaxShortcuts): WorkflowResultHints {
  return {
    triage: shortcuts.results ?? "/workflow:results",
    inspect: shortcuts.inspector ?? "/workflow:inspector",
    expand: keyText("app.tools.expand") || undefined,
  };
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
function registerWorkflowTool(
  pi: ExtensionAPI,
  reviewSessions: ReviewSessionCoordinator,
  backgroundWorkflows: BackgroundWorkflowCoordinator,
  shortcuts: DynamaxShortcuts,
  dynamax: DynamaxHandle,
): void {
  pi.registerTool({
    name: WORKFLOW_TOOL_NAME,
    label: "Workflow",
    description:
      "ONLY call workflow when the user opted into multi-agent orchestration via the literal token `dynamax`, sticky `/workflow:dynamax on`, an explicit request to run or author a workflow, or a command/skill instruction. Runs either a registered named workflow or an inline one-off workflow script (fan-out → verify → synthesize), synchronously by default or explicitly in the background.",
    promptSnippet: "Run an existing named workflow or an inline one-off workflow script",
    // Like codemode itself, an orchestrating tool stays a top-level model action: from a codemode script a
    // run would lose its tool row, hit the script's output cap, and parallel runs would each get their own
    // concurrency cap. It also stays declared under `codemode.mode: "only"`, which hides direct tools.
    exposure: "model-only",
    reachesTools: workflowToolReach,
    promptGuidelines: [
      "Use workflow only when the user opted into workflow orchestration via `dynamax`, sticky `/workflow:dynamax`, an explicit request to run/author a workflow, or a command/skill instruction.",
      `Before writing or editing an inline workflow script, read the workflow-authoring skill (${WORKFLOW_AUTHORING_SKILL_PATH}); it is the script API and pattern reference.`,
      "Every workflow tool call must provide exactly one of `name`, `script`, or `scriptPath`.",
      "Inline workflow scripts must use the injected `Type` global for schemas and must not contain imports or dynamic import().",
      "Set `profile: \"small\"`, `\"medium\"`, or `\"big\"` on every `api.agent()` call so the user's central model routes apply; use `model`/`thinkingLevel` only for an intentional override.",
      "When using `isolation: \"worktree\"`, `api.agent()` returns `{ result, patch, changed }`; use `.result` for the answer and `.patch` for the isolated diff.",
      "Host MCP tools reach subagents only in synchronous workflow tool runs, never in background runs.",
      "Set background: true only when the user explicitly wants the workflow to continue after this tool call; the tool returns a durable run ID and completion is delivered later.",
      "Set autoResumeOnUsageLimit: true only for an explicitly backgrounded workflow when the user wants bounded automatic continuation after a recognized provider usage window.",
      "Set resumeEditedWorkflow: true only with resumeFromRunId when the user explicitly accepts reusing behaviorally identical calls after workflow source edits.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Workflow name, e.g. code-review. Provide exactly one of name, script, or scriptPath." })),
      script: Type.Optional(Type.String({ description: "Inline workflow script. Provide exactly one of name, script, or scriptPath." })),
      scriptPath: Type.Optional(
        Type.String({
          description:
            "Path, relative to the working directory, of a file holding an inline workflow script. To iterate, edit in place the persisted .pi/.workflow-runs/<runId>.script.js a result names and rerun it here with resumeFromRunId, which accepts the edits as with resumeEditedWorkflow; editing any other copy in the repository, or a .pi/workflows script, changes repository state, so shared read-only agents rerun live. Provide exactly one of name, script, or scriptPath.",
        }),
      ),
      args: Type.Optional(
        Type.Unknown({
          description:
            "Arguments for the workflow: a string (e.g. target or focus) or any JSON value. The workflow reads the value as `api.input` and its text (JSON for non-strings) as `api.args`.",
        }),
      ),
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
        return workflowToolError("resumeFromRunId must be non-empty.", { error: "invalid_resume_from_run_id" });
      }
      if (params.resumeEditedWorkflow && !resumeFromRunId) {
        return workflowToolError("resumeEditedWorkflow requires resumeFromRunId.", { error: "invalid_edited_workflow_resume" });
      }
      if (params.background) {
        const unavailable = backgroundUnavailableResult(ctx.mode);
        if (unavailable) return unavailable;
      }
      const turnBudget = dynamax.turnBudget(ctx);
      const budget = resolveTurnBudget(turnBudget, { min: WORKFLOW_BUDGET_MIN, max: WORKFLOW_BUDGET_MAX });
      if (budget.kind === "spent") {
        return workflowToolError(
          `The user's +${budget.total} output-token budget for this turn is spent by its earlier workflow runs. Do not start another workflow this turn unless the user raises the budget.`,
          { error: "turn_budget_spent", total: budget.total },
        );
      }

      const runOptions = resolveWorkflowRunOptions({
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        maxAgents: params.maxAgents,
        agentTimeoutMs: params.agentTimeoutMs,
        agentRetries: params.agentRetries,
        autoResumeOnUsageLimit: params.autoResumeOnUsageLimit,
        usageLimitMaxAttempts: params.usageLimitMaxAttempts,
        usageLimitMaxDelayMs: params.usageLimitMaxDelayMs,
        budget: budget.budget,
        perf: params.perf,
        resumeFromRunId,
        // Rerunning an edited script file is the point of scriptPath; each call's own replay identity still guards reuse.
        resumeEditedWorkflow: params.resumeEditedWorkflow === true || request.kind === "script-path",
        signal,
      });
      const perfRecorder = await createInvocationPerf(runOptions);
      let mod: LoadedWorkflow;
      let resultName: string;

      if (request.kind === "named") {
        const workflows = await discoverForSession(ctx, { perf: perfRecorder });
        const named = workflows.get(request.name);
        if (!named) {
          const available = [...workflows.keys()].join(", ") || "(none)";
          return workflowToolError(`Unknown workflow "${request.name}". Available: ${available}`, { error: "unknown_workflow", available });
        }
        mod = named;
        resultName = request.name;
      } else {
        const compiled = await compileInlineToolWorkflow(ctx.cwd, request);
        if ("isError" in compiled) return compiled;
        mod = compiled;
        resultName = mod.meta.name;
      }

      // Omitted args match a slash command without arguments; any other value, null included, is kept verbatim.
      const resultArgs: unknown = params.args === undefined ? "" : params.args;
      if (params.background) {
        return await startBackgroundWorkflowTool({
          coordinator: backgroundWorkflows,
          ctx,
          name: resultName,
          options: runOptions,
          // Under Dynamax the agent is orchestrating, so its completion starts a turn to act on the result.
          wakeOnComplete: dynamax.isActive(ctx),
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
      // Only this synchronous path may bridge host MCP tools: executeTool ends with the tool call.
      const hostTools = createHostToolBridge(() => pi.getAllTools(), ctx);
      // Keep the latest usage: a failed run still reports what its agents spent instead of dropping it with the error.
      let spent: WorkflowUsageSnapshot | undefined;
      const onUsageSnapshot = (snapshot: WorkflowUsageSnapshot) => {
        spent = snapshot;
        return runOptions.onUsageSnapshot?.(snapshot);
      };
      // A failed run still names its run, script and journal, so the host can fix the script and resume.
      let run: WorkflowRunMetadata | undefined;
      const onRunMetadata = (metadata: WorkflowRunMetadata) => {
        run = metadata;
        return runOptions.onRunMetadata?.(metadata);
      };
      let envelope: WorkflowResultEnvelope;
      try {
        envelope = await executeResolvedWorkflow(
          pi,
          ctx,
          resultName,
          mod,
          resultArgs,
          { ...runOptions, hostTools, onUsageSnapshot, onRunMetadata },
          perfRecorder,
        );
      } catch (error) {
        const message = unknownErrorMessage(error);
        const lines = [`Workflow ${resultName} failed: ${message}`];
        if (run) lines.push("", formatWorkflowRunLine(run), ...formatWorkflowRunFileLines(run.runId, run.scriptPath !== undefined));
        return {
          ...workflowToolError(lines.join("\n"), { error: "workflow_failed", name: resultName, message }),
          usage: workflowUsageForPi(spent),
        };
      } finally {
        // Only synchronous runs draw the turn pool down; a background run's spend lands after the turn.
        turnBudget?.spend(spent?.totals.output ?? 0);
      }
      reviewSessions.remember(ctx, envelope, runOptions);
      return {
        content: [{ type: "text", text: formatWorkflowResultForContext(envelope) }],
        details: envelope,
        // pi counts tool-result usage toward the session cost; subagent spend was invisible there before.
        usage: workflowUsageForPi(envelope.usage),
      };
    },
  });
}
