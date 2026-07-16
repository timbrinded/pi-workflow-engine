import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowProgressSnapshot } from "./src/progress.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressSource, WorkflowRef, WorkflowRunMetadata, WorkflowRunOptions } from "./src/types.ts";
import { WorkflowInspector } from "./src/ui/workflow-inspector.ts";
import type { PerfSink, PerfSnapshot } from "./src/perf.ts";
import type { WorkflowUsageSnapshot } from "./src/usage.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE, dynamaxSessionKey, registerDynamax } from "./src/dynamax.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./src/dynamax-shortcuts.ts";
import { handleReviewViewerAction } from "./src/review/review-actions.ts";
import {
  codeReviewReport,
  decideReviewResultsPresentation,
  extensionContextMode,
  maybeShowReviewResultsViewer,
} from "./src/review/review-results-flow.ts";
import {
  formatWorkflowDetailLines,
  isAdvisoryReport,
  isWorkflowResult,
  renderWorkflowResult,
  type AdvisoryWorkflowResult,
  type WorkflowPerfDetails,
  type WorkflowResultEnvelope,
} from "./src/ui/workflow-result-renderer.ts";
import { parseWorkflowBudgetString, WORKFLOW_BUDGET_MAX, WORKFLOW_BUDGET_MIN } from "./src/options.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

function summarize(result: unknown): string {
  if (result && typeof result === "object" && typeof (result as { summary?: unknown }).summary === "string") {
    return (result as { summary: string }).summary;
  }
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

function workflowEnvelope(
  name: string,
  result: unknown,
  usage?: WorkflowUsageSnapshot,
  perf?: WorkflowPerfDetails,
  metadata?: WorkflowRunMetadata,
): WorkflowResultEnvelope {
  return { name, result, completedAt: Date.now(), usage, perf, runId: metadata?.runId, resumedFromRunId: metadata?.resumedFromRunId };
}

function compactPerfSnapshot(snapshot: PerfSnapshot | undefined): WorkflowPerfDetails | undefined {
  if (!snapshot?.enabled) return undefined;
  return { enabled: true, startedAt: snapshot.startedAt, aggregates: snapshot.aggregates };
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

async function createInvocationPerf(options: WorkflowRunOptions): Promise<PerfSink | undefined> {
  const enabled = options.perf ?? process.env.PI_WORKFLOW_PERF === "1";
  if (!enabled) return undefined;
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

let lastWorkflowInspection: LastWorkflowInspection | undefined;
let activeWorkflowInspection: ActiveWorkflowInspection | undefined;
const codeReviewResults = new WeakMap<ExtensionAPI, Map<string, AdvisoryWorkflowResult>>();

export function getLastWorkflowInspection(): LastWorkflowInspection | undefined {
  return lastWorkflowInspection;
}

export function getActiveWorkflowInspection(): ActiveWorkflowInspection | undefined {
  return activeWorkflowInspection;
}

export async function openWorkflowInspector(ctx: ExtensionContext, inspection: LastWorkflowInspection | ActiveWorkflowInspection): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WorkflowInspector(snapshotGetter(inspection), tui, theme, () => done(undefined)),
    { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
  );
}

async function openAvailableWorkflowInspector(ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Workflow inspector requires the TUI", "warning");
    return;
  }
  const inspection = activeWorkflowInspection ?? lastWorkflowInspection;
  if (!inspection) {
    ctx.ui.notify("No workflow inspector is available yet", "warning");
    return;
  }
  await openWorkflowInspector(ctx, inspection);
}

function rememberCodeReviewResult(pi: ExtensionAPI, ctx: ExtensionContext, name: string, result: unknown): void {
  if (name !== "code-review") return;
  const key = dynamaxSessionKey(ctx);
  const report = codeReviewReport(name, result);
  if (!report) {
    codeReviewResults.get(pi)?.delete(key);
    return;
  }
  const retained = codeReviewResults.get(pi) ?? new Map<string, AdvisoryWorkflowResult>();
  retained.set(key, report);
  codeReviewResults.set(pi, retained);
}

async function openAvailableReviewResults(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI || extensionContextMode(ctx) !== "tui") {
    ctx.ui.notify("Code-review results viewer requires the TUI", "warning");
    return;
  }
  const lastCodeReviewResult = codeReviewResults.get(pi)?.get(dynamaxSessionKey(ctx));
  if (!lastCodeReviewResult) {
    ctx.ui.notify("No code-review result is available yet. Run /workflow code-review first.", "warning");
    return;
  }
  if (lastCodeReviewResult.findings.length === 0) {
    ctx.ui.notify("The last code review had no findings", "info");
    return;
  }

  const decision = decideReviewResultsPresentation({
    workflowName: "code-review",
    result: lastCodeReviewResult,
    mode: "tui",
    hasUI: true,
    resultViewer: "open",
    invocationKind: "command",
  });
  if (decision.kind !== "open") return;

  const action = await maybeShowReviewResultsViewer(ctx, decision);
  const followUp = await handleReviewViewerAction(pi, ctx, action, decision.issues, decision.report.reviewContext);
  if (followUp) await sendWorkflowResult(pi, ctx, followUp.meta.name, followUp, "", { resultViewer: "skip" });
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
    if (token.startsWith("--concurrency=")) {
      options.concurrency = parseNumericOption(token.slice("--concurrency=".length));
      continue;
    }
    if (token === "--concurrency") {
      const next = tokens[i + 1];
      options.concurrency = parseNumericOption(next);
      if (next !== undefined) i++;
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
): Promise<void> {
  let invocation: WorkflowResultInvocation | undefined = { name, mod, args, options, perfRecorder };
  while (invocation !== undefined) {
    invocation = await runAndSendWorkflowResult(pi, ctx, invocation);
  }
}

interface WorkflowResultInvocation {
  readonly name: string;
  readonly mod: LoadedWorkflow;
  readonly args: string;
  readonly options: WorkflowRunOptions;
  readonly perfRecorder?: PerfSink;
}

async function runAndSendWorkflowResult(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  invocation: WorkflowResultInvocation,
): Promise<WorkflowResultInvocation | undefined> {
  const { name, mod, args, options, perfRecorder } = invocation;
  const { runWorkflow } = await loadEngine();
  let perfSnapshot: PerfSnapshot | undefined;
  let usageSnapshot: WorkflowUsageSnapshot | undefined;
  let runMetadata: WorkflowRunMetadata | undefined;
  let liveInspection: ActiveWorkflowInspection | undefined;
  const result = await runWorkflow(ctx, mod, args, {
    ...options,
    perf: options.perf ?? perfRecorder !== undefined,
    perfRecorder,
    resolveWorkflow: (ref) => resolveWorkflowRef(ref, perfRecorder),
    onProgressSource(source) {
      if (source) {
        liveInspection = bindActiveWorkflowInspection(name, args, source);
        activeWorkflowInspection = liveInspection;
      } else if (activeWorkflowInspection === liveInspection) {
        activeWorkflowInspection = undefined;
        liveInspection = undefined;
      }
      options.onProgressSource?.(source);
    },
    onPerfSnapshot(snapshot) {
      perfSnapshot = snapshot;
      options.onPerfSnapshot?.(snapshot);
    },
    onUsageSnapshot(snapshot) {
      usageSnapshot = snapshot;
      options.onUsageSnapshot?.(snapshot);
    },
    onRunMetadata(metadata) {
      runMetadata = metadata;
      options.onRunMetadata?.(metadata);
    },
    onProgressSnapshot(snapshot) {
      lastWorkflowInspection = { name, args, completedAt: snapshot.doneAt ?? Date.now(), snapshot };
      options.onProgressSnapshot?.(snapshot);
    },
  });
  rememberCodeReviewResult(pi, ctx, name, result);
  const perf = compactPerfSnapshot(perfSnapshot);
  const reviewDecision = decideReviewResultsPresentation({
    workflowName: name,
    result,
    mode: extensionContextMode(ctx),
    hasUI: ctx.hasUI,
    resultViewer: options.resultViewer,
    invocationKind: "command",
  });
  const reviewAction = await maybeShowReviewResultsViewer(ctx, reviewDecision);
  pi.sendMessage(
    {
      customType: "workflow-result",
      content: formatMessageContent(name, result, usageSnapshot, perf, runMetadata),
      display: true,
      details: workflowEnvelope(name, result, usageSnapshot, perf, runMetadata),
    },
    { triggerTurn: false },
  );
  if (reviewDecision.kind === "send") return;

  const followUp = await handleReviewViewerAction(pi, ctx, reviewAction, reviewDecision.issues, reviewDecision.report.reviewContext);
  if (!followUp) return;
  return {
    name: followUp.meta.name,
    mod: followUp,
    args: "",
    options: reviewFollowUpOptions(options),
  };
}

function reviewFollowUpOptions(options: WorkflowRunOptions): WorkflowRunOptions {
  return {
    concurrency: options.concurrency,
    parallelSubmissionLimit: options.parallelSubmissionLimit,
    budget: options.budget,
    perf: options.perf,
    resultViewer: "skip",
    signal: options.signal,
  };
}

export default function workflowEngine(pi: ExtensionAPI, shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts()): void {
  registerDynamax(pi, shortcuts, { openInspector: openAvailableWorkflowInspector });
  if (shortcuts.results) {
    pi.registerShortcut(shortcuts.results, {
      description: "Open last code-review results",
      handler: async (ctx) => {
        await openAvailableReviewResults(pi, ctx);
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
      await openAvailableWorkflowInspector(ctx);
    },
  });

  pi.registerCommand("workflow:results", {
    description: "Reopen the last code-review findings viewer",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /workflow:results", "warning");
        return;
      }
      await openAvailableReviewResults(pi, ctx);
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
      const perfRecorder = await createInvocationPerf(direct.options);
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

      await sendWorkflowResult(pi, ctx, invocation.name, mod, invocation.args, invocation.options, perfRecorder);
    },
  });

  // workflow tool — lets the host agent fan out mid-conversation.
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

      const runOptions: WorkflowRunOptions = {
        inspect: ctx.hasUI,
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        budget: params.budget,
        perf: params.perf,
        resumeFromRunId,
        signal,
      };
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

      const { runWorkflow } = await loadEngine();
      let perfSnapshot: PerfSnapshot | undefined;
      let usageSnapshot: WorkflowUsageSnapshot | undefined;
      let runMetadata: WorkflowRunMetadata | undefined;
      let liveInspection: ActiveWorkflowInspection | undefined;
      const resultArgs = params.args ?? "";
      const result = await runWorkflow(ctx, mod, resultArgs, {
        ...runOptions,
        perf: runOptions.perf ?? perfRecorder !== undefined,
        perfRecorder,
        resolveWorkflow: (ref) => resolveWorkflowRef(ref, perfRecorder),
        onProgressSource(source) {
          if (source) {
            liveInspection = bindActiveWorkflowInspection(resultName, resultArgs, source);
            activeWorkflowInspection = liveInspection;
          } else if (activeWorkflowInspection === liveInspection) {
            activeWorkflowInspection = undefined;
            liveInspection = undefined;
          }
        },
        onPerfSnapshot: (snapshot) => {
          perfSnapshot = snapshot;
        },
        onUsageSnapshot: (snapshot) => {
          usageSnapshot = snapshot;
        },
        onRunMetadata: (metadata) => {
          runMetadata = metadata;
        },
        onProgressSnapshot: (snapshot) => {
          // Record the run so /workflow:inspector can reopen it — tool-invoked (dynamax) runs were
          // previously uninspectable, unlike the /workflow command path.
          lastWorkflowInspection = { name: resultName, args: resultArgs, completedAt: snapshot.doneAt ?? Date.now(), snapshot };
        },
      });
      rememberCodeReviewResult(pi, ctx, resultName, result);
      const perf = compactPerfSnapshot(perfSnapshot);
      return {
        content: [{ type: "text", text: formatMessageContent(resultName, result, usageSnapshot, perf, runMetadata) }],
        details: workflowEnvelope(resultName, result, usageSnapshot, perf, runMetadata),
      };
    },
  });
}
