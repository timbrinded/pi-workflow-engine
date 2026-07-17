import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { isAdvisoryReport } from "./src/advisory-schema.ts";
import type { WorkflowProgressSnapshot } from "./src/progress-types.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressSource, WorkflowRef, WorkflowRunMetadata, WorkflowRunOptions } from "./src/types.ts";
import { WorkflowInspector } from "./src/ui/workflow-inspector.ts";
import type { PerfSink } from "./src/perf.ts";
import type { WorkflowUsageSnapshot } from "./src/usage.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE, registerDynamax } from "./src/dynamax.ts";
import { sessionKey } from "./src/session-identity.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./src/dynamax-shortcuts.ts";
import { ReviewSessionCoordinator } from "./src/review/review-session-coordinator.ts";
import {
  formatWorkflowDetailLines,
  isWorkflowResult,
  renderWorkflowResult,
} from "./src/ui/workflow-result-renderer.ts";
import {
  parseWorkflowBudgetString,
  resolveWorkflowRunOptions,
  type ResolvedWorkflowRunOptions,
  WORKFLOW_BUDGET_MAX,
  WORKFLOW_BUDGET_MIN,
} from "./src/options.ts";
import { executeWorkflowInvocation, type WorkflowExecution, type WorkflowPerfDetails } from "./src/workflow-execution.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

function summarize(result: unknown): string {
  if (typeof result === "object" && result !== null && "summary" in result && typeof result.summary === "string") return result.summary;
  return typeof result === "string" ? result : "Workflow finished.";
}

function formatMessageContent(
  name: string,
  result: unknown,
  usage?: WorkflowUsageSnapshot,
  perf?: WorkflowPerfDetails,
  metadata?: WorkflowRunMetadata,
): string {
  const details = formatWorkflowDetailLines({ usage, perf, metadata });
  return `## Workflow: ${name}\n\n${formatResultForContext(result)}${details.length > 0 ? `\n\n${details.join("\n")}` : ""}`;
}

function formatResultForContext(result: unknown): string {
  if (!isAdvisoryReport(result)) return summarize(result);

  const lines = [result.summary];
  if (result.findings.length > 0) {
    lines.push("", "Findings:");
    result.findings.forEach((finding, index) => {
      const id = `R${String(index + 1).padStart(3, "0")}`;
      lines.push(
        `\n### ${id}: ${finding.summary}`,
        `- Severity: ${finding.severity}`,
        `- Confidence: ${finding.confidence}`,
        `- Category: ${finding.category}`,
        `- Location: ${finding.locations.map(formatFindingLocation).join(", ")}`,
        `- Impact: ${finding.impact}`,
        `- Evidence: ${finding.evidence.length > 0 ? finding.evidence.join("; ") : "(none cited)"}`,
        `- Recommendation: ${finding.recommendation}`,
      );
    });
  }
  if (result.nextSteps.length > 0) {
    lines.push("", "Next steps:", ...result.nextSteps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function formatFindingLocation(location: { readonly file: string; readonly line?: number; readonly symbol?: string }): string {
  const line = location.line === undefined ? "" : `:${location.line}`;
  const symbol = location.symbol === undefined ? "" : ` (${location.symbol})`;
  return `${location.file}${line}${symbol}`;
}

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
const WORKFLOW_PICKER_MAX_VISIBLE = 8;
const WORKFLOW_PICKER_LAYOUT = { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 22 };

class WorkflowPickerComponent implements Component {
  private readonly list: SelectList;

  constructor(
    items: SelectItem[],
    private readonly tui: TUI,
    private readonly theme: Theme,
    done: (value: string | undefined) => void,
  ) {
    this.list = new SelectList(items, Math.min(WORKFLOW_PICKER_MAX_VISIBLE, items.length), selectListTheme(theme), WORKFLOW_PICKER_LAYOUT);
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
    this.list.onSelectionChange = () => this.tui.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(20, width);
    const rule = this.theme.fg("borderMuted", "-".repeat(safeWidth));
    const lines = [
      rule,
      this.theme.fg("accent", this.theme.bold("Run workflow")),
      "",
      ...this.list.render(safeWidth),
      "",
      this.theme.fg("muted", "up/down navigate  enter select  escape cancel"),
      rule,
    ];
    return lines.map((line) => truncateToWidth(line, safeWidth));
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
    this.tui.requestRender();
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("muted", text),
    noMatch: (text) => theme.fg("muted", text),
  };
}

function workflowPickerItems(workflows: ReadonlyMap<string, WorkflowModule>): SelectItem[] {
  return [
    { value: AUTHOR_TEMP_WORKFLOW_VALUE, label: AUTHOR_TEMP_WORKFLOW_LABEL, description: AUTHOR_TEMP_WORKFLOW_DESCRIPTION },
    ...[...workflows.values()].map((mod) => ({ value: mod.meta.name, label: mod.meta.name, description: mod.meta.description })),
  ];
}

async function selectWorkflowValue(workflows: ReadonlyMap<string, WorkflowModule>, ctx: ExtensionCommandContext): Promise<string | undefined> {
  const items = workflowPickerItems(workflows);
  if (typeof ctx.ui.custom === "function") {
    return await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => new WorkflowPickerComponent(items, tui, theme, done));
  }

  const choice = await ctx.ui.select(
    "Run workflow",
    items.map((item) => item.label),
  );
  return items.find((item) => item.label === choice)?.value ?? choice;
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
let latestWorkflowInspection: LastWorkflowInspection | undefined;
let latestActiveWorkflowInspection: ActiveWorkflowInspection | undefined;

export function getLastWorkflowInspection(): LastWorkflowInspection | undefined {
  return latestWorkflowInspection;
}

export async function openWorkflowInspector(ctx: ExtensionContext, inspection: LastWorkflowInspection | ActiveWorkflowInspection): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WorkflowInspector(snapshotGetter(inspection), tui, theme, () => done(undefined)),
    { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
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
  if (!ctx.hasUI) {
    ctx.ui.notify("Workflow inspector requires the TUI", "warning");
    return;
  }
  const state = workflowInspectionState(pi, ctx);
  const inspection = state.active ?? state.last;
  if (!inspection) {
    ctx.ui.notify("No workflow inspector is available yet", "warning");
    return;
  }
  await openWorkflowInspector(ctx, inspection);
}

function snapshotGetter(inspection: LastWorkflowInspection | ActiveWorkflowInspection): () => WorkflowProgressSnapshot {
  const snapshot = inspection.snapshot;
  return typeof snapshot === "function" ? snapshot : () => snapshot;
}

function bindActiveWorkflowInspection(name: string, args: string, source: WorkflowProgressSource): ActiveWorkflowInspection {
  return { name, args, startedAt: Date.now(), snapshot: () => source.snapshot() };
}

export interface WorkflowInvocation {
  name: string;
  args: string;
  options: WorkflowRunOptions;
  refreshDiscovery?: boolean;
  optionErrors?: string[];
  authorBrief?: string;
}

export function parseWorkflowInvocation(input: string): WorkflowInvocation {
  const trimmed = input.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const { args, options, refreshDiscovery, optionErrors } = parseWorkflowOptions(rest);
  const invocation: WorkflowInvocation = { name, args, options };
  if (refreshDiscovery) invocation.refreshDiscovery = refreshDiscovery;
  if (optionErrors) invocation.optionErrors = optionErrors;
  return invocation;
}

const INVALID_BUDGET_OPTION = "--budget requires a positive integer output-token count";
const INVALID_RESUME_OPTION = "--resume requires a workflow run id";

type WorkflowOptionValueSource = "equals" | "next-token";

interface WorkflowOptionValue {
  readonly candidate: string | undefined;
  readonly source: WorkflowOptionValueSource;
  readonly consumedTokenCount: 0 | 1;
}

function parseWorkflowOptions(input: string): { args: string; options: WorkflowRunOptions; refreshDiscovery?: boolean; optionErrors?: string[] } {
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const options: WorkflowRunOptions = {};
  const optionErrors: string[] = [];
  let refreshDiscovery = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--inspect") {
      options.inspect = true;
      continue;
    }
    if (token === "--refresh") {
      refreshDiscovery = true;
      continue;
    }
    if (token === "--perf") {
      options.perf = true;
      continue;
    }
    if (token === "--result-viewer" || token === "--review-viewer") {
      options.resultViewer = "open";
      continue;
    }
    if (token === "--no-result-viewer" || token === "--no-review-viewer") {
      options.resultViewer = "skip";
      continue;
    }
    const concurrencyValue = readWorkflowOptionValue(tokens, i, "--concurrency");
    if (concurrencyValue) {
      options.concurrency = parseNumericOption(concurrencyValue.candidate);
      i += concurrencyValue.consumedTokenCount;
      continue;
    }
    if (token.startsWith("--parallel-limit=")) {
      options.parallelSubmissionLimit = parseNumericOption(token.slice("--parallel-limit=".length));
      continue;
    }
    if (token === "--parallel-limit") {
      const next = tokens[i + 1];
      options.parallelSubmissionLimit = parseNumericOption(next);
      if (next !== undefined) i++;
      continue;
    }
    if (token.startsWith("--budget=")) {
      const parsed = parseBudgetOption(token.slice("--budget=".length));
      if (parsed === undefined) optionErrors.push(INVALID_BUDGET_OPTION);
      else options.budget = parsed;
      continue;
    }
    if (token === "--budget") {
      const next = tokens[i + 1];
      const parsed = next === undefined ? undefined : parseBudgetOption(next);
      if (parsed === undefined) {
        optionErrors.push(INVALID_BUDGET_OPTION);
      } else {
        options.budget = parsed;
        i++;
      }
      continue;
    }
    if (token.startsWith("--resume=")) {
      const value = token.slice("--resume=".length).trim();
      if (value === "") optionErrors.push(INVALID_RESUME_OPTION);
      else options.resumeFromRunId = value;
      continue;
    }
    if (token === "--resume") {
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("--")) {
        optionErrors.push(INVALID_RESUME_OPTION);
      } else {
        options.resumeFromRunId = next;
        i++;
      }
      continue;
    }
    kept.push(token);
  }
  return { args: kept.join(" ").trim(), options, refreshDiscovery: refreshDiscovery || undefined, optionErrors: optionErrors.length > 0 ? optionErrors : undefined };
}

function readWorkflowOptionValue(tokens: readonly string[], index: number, option: string): WorkflowOptionValue | undefined {
  const token = tokens[index];
  const equalsPrefix = `${option}=`;
  if (token.startsWith(equalsPrefix)) {
    return { candidate: token.slice(equalsPrefix.length), source: "equals", consumedTokenCount: 0 };
  }
  if (token !== option) return undefined;
  const candidate = tokens[index + 1];
  return { candidate, source: "next-token", consumedTokenCount: candidate === undefined ? 0 : 1 };
}

function parseBudgetOption(value: string): number | undefined {
  return parseWorkflowBudgetString(value);
}

function parseNumericOption(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compactInlinePreview(script: string | undefined): string {
  if (!script) return "";
  const compact = script.replace(/\s+/g, " ").trim();
  return compact.length > 60 ? `${compact.slice(0, 57)}…` : compact;
}

export function buildTemporaryWorkflowAuthorPrompt(brief: string): string {
  return `dynamax author and run a temporary one-shot inline workflow.

User brief:
${brief.trim()}

Use the workflow tool with a script argument, not a saved workflow name.
The script must start with export const meta = { ... } and default-export an async workflow function.
Use the injected Type object for schemas. Do not import anything or use dynamic import().
Set thinkingLevel explicitly on each agent() call.
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

export async function pickWorkflow(
  workflows: ReadonlyMap<string, WorkflowModule>,
  ctx: ExtensionCommandContext,
): Promise<WorkflowInvocation | undefined> {
  const choice = await selectWorkflowValue(workflows, ctx);
  if (!choice) return undefined;

  if (choice === AUTHOR_TEMP_WORKFLOW_VALUE || choice === AUTHOR_TEMP_WORKFLOW_LABEL) {
    const brief = await ctx.ui.editor(
      "Describe temporary workflow",
      "Goal:\n\nAgents to run:\n- \n\nFinal output should include:\n- summary\n- findings\n- next steps\n",
    );
    const trimmed = brief?.trim();
    if (!trimmed) return undefined;
    return { name: "", args: "", options: {}, authorBrief: trimmed };
  }

  const separator = choice.indexOf(" — ");
  const name = separator === -1 ? choice : choice.slice(0, separator);
  const args = name === "code-review" ? (await ctx.ui.input("Code-review target/instructions", "Blank = auto-detect diff"))?.trim() ?? "" : "";
  return { name, args, options: {} };
}

export async function sendWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: WorkflowRunOptions,
  perfRecorder?: PerfSink,
  reviewSessions: ReviewSessionCoordinator = createReviewSessionCoordinator(pi),
): Promise<void> {
  await sendResolvedWorkflowResult(
    pi,
    ctx,
    name,
    mod,
    args,
    resolveWorkflowRunOptions(options),
    perfRecorder,
    reviewSessions,
  );
}

async function sendResolvedWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder: PerfSink | undefined,
  reviewSessions: ReviewSessionCoordinator,
): Promise<void> {
  const execution = await executeResolvedWorkflow(pi, ctx, name, mod, args, options, perfRecorder);
  reviewSessions.remember(ctx, execution, options);
  sendWorkflowExecution(pi, execution);
  await reviewSessions.present(ctx, execution, options);
}

async function executeResolvedWorkflow(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  name: string,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<WorkflowExecution> {
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
        latestActiveWorkflowInspection = liveInspection;
      } else if (inspections.active === liveInspection) {
        inspections.active = undefined;
        if (latestActiveWorkflowInspection === liveInspection) latestActiveWorkflowInspection = undefined;
        liveInspection = undefined;
      }
    },
    onProgressSnapshot(snapshot) {
      const completed = { name, args, completedAt: snapshot.doneAt ?? Date.now(), snapshot };
      inspections.last = completed;
      latestWorkflowInspection = completed;
    },
  });
}

function sendWorkflowExecution(pi: ExtensionAPI, execution: WorkflowExecution): void {
  const { name } = execution.envelope;
  pi.sendMessage(
    {
      customType: "workflow-result",
      content: formatMessageContent(
        name,
        execution.envelope.result,
        execution.envelope.usage,
        execution.envelope.perf,
        execution.metadata,
      ),
      display: true,
      details: execution.envelope,
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
    publish: (execution) => sendWorkflowExecution(pi, execution),
  });
}

export default function workflowEngine(pi: ExtensionAPI, shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts()): void {
  const reviewSessions = createReviewSessionCoordinator(pi);
  registerDynamax(pi, shortcuts, { openInspector: (ctx) => openAvailableWorkflowInspector(pi, ctx) });
  pi.on("session_shutdown", (_event, ctx) => {
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
    if (isWorkflowResult(details)) {
      return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, {
        runId: details.runId,
        resumedFromRunId: details.resumedFromRunId,
      }, details.perf);
    }
    return renderWorkflowResult("workflow", details ?? message.content, expanded, theme);
  });

  pi.registerCommand("workflow:inspector", {
    description: "Open the current or last workflow inspector",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (trimmed && trimmed !== "last") {
        ctx.ui.notify("Usage: /workflow:inspector [last]", "warning");
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
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const direct = parseWorkflowInvocation(args);
      if (direct.optionErrors?.length) {
        ctx.ui.notify(`Invalid workflow option: ${direct.optionErrors.join("; ")}`, "warning");
        return;
      }
      const directOptions = resolveWorkflowRunOptions(direct.options);
      const perfRecorder = await createInvocationPerf(directOptions);
      const { discoverWorkflows } = await loadDiscovery();
      const workflows = await discoverWorkflows(EXTENSION_DIR, { refresh: direct.refreshDiscovery, perf: perfRecorder });
      const available = [...workflows.keys()].join(", ") || "(none)";
      const invocation = direct.name ? direct : ctx.hasUI ? await pickWorkflow(workflows, ctx) : undefined;

      if (!invocation) {
        ctx.ui.notify(`Usage: /workflow <name> [args]. Available: ${available}`, "warning");
        return;
      }

      if (invocation.authorBrief) {
        pi.sendUserMessage(buildTemporaryWorkflowAuthorPrompt(invocation.authorBrief));
        return;
      }

      const mod = workflows.get(invocation.name);
      if (!mod) {
        ctx.ui.notify(`Unknown workflow "${invocation.name}". Available: ${available}`, "error");
        return;
      }

      const effectiveOptions = invocation === direct ? directOptions : resolveWorkflowRunOptions(invocation.options);
      await sendResolvedWorkflowResult(pi, ctx, invocation.name, mod, invocation.args, effectiveOptions, perfRecorder, reviewSessions);
    },
  });

  registerWorkflowTool(pi, reviewSessions);
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
function registerWorkflowTool(pi: ExtensionAPI, reviewSessions: ReviewSessionCoordinator): void {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "ONLY call workflow when the user opted into multi-agent orchestration via the literal token `dynamax`, sticky `/workflow:dynamax on`, an explicit request to run or author a workflow, or a command/skill instruction. Runs either a registered named workflow or an inline one-off workflow script (fan-out → verify → synthesize) and returns its structured result.",
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
      "Every workflow tool call must provide exactly one of `name` or `script`, never both.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Workflow name, e.g. code-review. Provide exactly one of name or script." })),
      script: Type.Optional(Type.String({ description: "Inline workflow script. Provide exactly one of script or name." })),
      args: Type.Optional(Type.String({ description: "Arguments for the workflow (e.g. target or focus)" })),
      concurrency: Type.Optional(Type.Number({ description: "Optional per-run agent concurrency cap" })),
      parallelSubmissionLimit: Type.Optional(Type.Number({ description: "Optional limit for eagerly submitted parallel thunks" })),
      budget: Type.Optional(
        Type.Integer({
          minimum: WORKFLOW_BUDGET_MIN,
          maximum: WORKFLOW_BUDGET_MAX,
          description: "Optional output-token ceiling for the run; agent() throws once it is exceeded",
        }),
      ),
      perf: Type.Optional(Type.Boolean({ description: "Include workflow performance timing aggregates in the result details" })),
      resumeFromRunId: Type.Optional(Type.String({ minLength: 1, description: "Workflow run id to resume from by replaying matching completed agent results" })),
    }),
    renderCall(args, theme) {
      const suffix = args.args ? ` ${theme.fg("dim", args.args)}` : "";
      if (args.name?.trim()) {
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", args.name.trim())}${suffix}`, 0, 0);
      }
      const preview = compactInlinePreview(args.script);
      const previewSuffix = preview ? ` ${theme.fg("dim", preview)}` : "";
      return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", "inline")}${suffix}${previewSuffix}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "Running workflow…"), 0, 0);
      const details = result.details;
      if (isWorkflowResult(details)) {
        return renderWorkflowResult(details.name, details.result, expanded, theme, details.usage, {
          runId: details.runId,
          resumedFromRunId: details.resumedFromRunId,
        }, details.perf);
      }
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Workflow finished.";
      return new Text(theme.fg("muted", text), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = normalizeWorkflowToolRequest(params);
      if (request.kind === "error") return invalidWorkflowInvocationResult();
      const resumeFromRunId = params.resumeFromRunId?.trim();
      if (params.resumeFromRunId !== undefined && resumeFromRunId === "") {
        return {
          content: [{ type: "text", text: "resumeFromRunId must be non-empty." }],
          details: { error: "invalid_resume_from_run_id" },
        };
      }

      const runOptions = resolveWorkflowRunOptions({
        inspect: ctx.hasUI,
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        budget: params.budget,
        perf: params.perf,
        resumeFromRunId,
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
      const execution = await executeResolvedWorkflow(pi, ctx, resultName, mod, resultArgs, runOptions, perfRecorder);
      reviewSessions.remember(ctx, execution, runOptions);
      return {
        content: [{
          type: "text",
          text: formatMessageContent(
            resultName,
            execution.envelope.result,
            execution.envelope.usage,
            execution.envelope.perf,
            execution.metadata,
          ),
        }],
        details: execution.envelope,
      };
    },
  });
}
