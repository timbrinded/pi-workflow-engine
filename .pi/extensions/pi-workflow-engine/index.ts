import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { isAdvisoryReport, type AdvisoryFinding, type AdvisoryLocation, type AdvisoryReport } from "./src/advisory-schema.ts";
import { isRecord } from "./src/guards.ts";
import type { WorkflowProgressSnapshot } from "./src/progress-types.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressSource, WorkflowRef, WorkflowRunOptions } from "./src/types.ts";
import { WorkflowInspector } from "./src/ui/workflow-inspector.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./src/ui/workflow-viewer-layout.ts";
import type { PerfSink } from "./src/perf.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE, registerDynamax } from "./src/dynamax.ts";
import { sessionKey } from "./src/session-identity.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./src/dynamax-shortcuts.ts";
import { toReviewIssues } from "./src/review/review-issues.ts";
import { ReviewSessionCoordinator } from "./src/review/review-session-coordinator.ts";
import {
  formatWorkflowDetailLines,
  isWorkflowResult,
  renderWorkflowResult,
} from "./src/ui/workflow-result-renderer.ts";
import {
  parseWorkflowBudgetString,
  parseWorkflowIntegerString,
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
import { executeWorkflowInvocation, workflowResultSummary, type WorkflowExecution, type WorkflowResultEnvelope } from "./src/workflow-execution.ts";
import { registerWorkflowModelProfileCommand } from "./src/model-profile-command.ts";
import { BackgroundWorkflowCoordinator } from "./src/background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./src/background-workflow-tool.ts";
import { registerWorkflowRunCommand, WorkflowRunController } from "./src/workflow-run-controller.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./src/command-completions.ts";
import { assertSupportedPiVersion } from "./src/pi-compat.ts";
import { truncateText } from "./src/text.ts";
import { formatWorkflowInspection, workflowInspectionSnapshot } from "./src/ui/workflow-format.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

/** Cap on the result JSON copied into the host agent's context; the run record keeps the full value. */
const MAX_CONTEXT_RESULT_JSON_CHARS = 20_000;

function formatMessageContent(envelope: WorkflowResultEnvelope): string {
  const details = formatWorkflowDetailLines(envelope);
  return `## Workflow: ${envelope.name}\n\n${formatResultForContext(envelope.name, envelope.result)}${details.length > 0 ? `\n\n${details.join("\n")}` : ""}`;
}

/** The host model only sees this text, never the envelope `details`, so it carries every result field. */
function formatResultForContext(name: string, result: unknown): string {
  if (typeof result === "string") return result;
  if (isAdvisoryReport(result)) return formatAdvisoryReportForContext(name, result);
  const summary = workflowResultSummary(result);
  if (summary !== undefined && isRecord(result) && Object.keys(result).length === 1) return summary;
  const json = formatResultJson(result);
  if (json === undefined) return summary ?? "Workflow finished.";
  return summary === undefined ? json : `${summary}\n\n${json}`;
}

function formatAdvisoryReportForContext(name: string, report: AdvisoryReport): string {
  const lines = [report.summary];
  const issues = toReviewIssues(name, report);
  if (issues.length > 0) {
    lines.push("", "Findings:");
    for (const { id, finding } of issues) {
      lines.push(
        `\n### ${id}: ${finding.summary}`,
        `- Severity: ${finding.severity}`,
        `- Confidence: ${finding.confidence}`,
        `- Category: ${finding.category}`,
        `- Location: ${formatFindingLocations(finding)}`,
        `- Impact: ${finding.impact}`,
        `- Evidence: ${finding.evidence.length > 0 ? finding.evidence.join("; ") : "(none cited)"}`,
        `- Recommendation: ${finding.recommendation}`,
      );
    }
  }
  if (report.gaps && report.gaps.length > 0) {
    lines.push("", "Coverage gaps:", ...report.gaps.map((gap) => `- ${gap}`));
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function formatResultJson(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  let json: string | undefined;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    return undefined;
  }
  if (json === undefined) return undefined;
  if (json.length <= MAX_CONTEXT_RESULT_JSON_CHARS) return `Result:\n\`\`\`json\n${json}\n\`\`\``;
  return `Result (first ${MAX_CONTEXT_RESULT_JSON_CHARS} of ${json.length} characters; truncated, the run record holds the full value):\n\`\`\`json\n${json.slice(0, MAX_CONTEXT_RESULT_JSON_CHARS)}\n\`\`\``;
}

/** The review anchor that the findings viewer and PR comments cite comes first, then every other cited location. */
function formatFindingLocations(finding: AdvisoryFinding): string {
  const locations = finding.reviewAnchor ? [finding.reviewAnchor, ...finding.locations] : finding.locations;
  return [...new Set(locations.map(formatFindingLocation))].join(", ");
}

function formatFindingLocation(location: AdvisoryLocation): string {
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
  return { name, ...parseWorkflowOptions(rest) };
}

const INVALID_RESUME_OPTION = "--resume requires a workflow run id";
const INVALID_EDITED_RESUME_OPTION = "--resume-edited requires --resume <run-id>";

interface NumericOptionFlag {
  readonly flag: string;
  readonly key: "concurrency" | "parallelSubmissionLimit" | "maxAgents" | "agentTimeoutMs" | "agentRetries" | "budget";
  readonly parse: (value: string | undefined) => number | undefined;
  readonly error: string;
}

/** `--flag=N` or `--flag N`; the next token is consumed only when it parses, so a following flag or argument survives. */
const NUMERIC_OPTION_FLAGS: readonly NumericOptionFlag[] = [
  { flag: "--concurrency", key: "concurrency", parse: parseWorkflowIntegerString, error: "--concurrency requires an integer" },
  { flag: "--parallel-limit", key: "parallelSubmissionLimit", parse: parseWorkflowIntegerString, error: "--parallel-limit requires an integer" },
  { flag: "--max-agents", key: "maxAgents", parse: parseWorkflowIntegerString, error: "--max-agents requires an integer" },
  { flag: "--agent-timeout-ms", key: "agentTimeoutMs", parse: parseWorkflowIntegerString, error: "--agent-timeout-ms requires an integer" },
  { flag: "--agent-retries", key: "agentRetries", parse: parseWorkflowIntegerString, error: "--agent-retries requires an integer" },
  { flag: "--budget", key: "budget", parse: parseWorkflowBudgetString, error: "--budget requires a positive integer output-token count" },
];

function parseWorkflowOptions(input: string): Omit<WorkflowInvocation, "name" | "authorBrief"> {
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
    if (token === "--resume-edited") {
      options.resumeEditedWorkflow = true;
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
    const numeric = NUMERIC_OPTION_FLAGS.find(({ flag }) => token === flag || token.startsWith(`${flag}=`));
    if (numeric) {
      const inline = token !== numeric.flag;
      const parsed = numeric.parse(inline ? token.slice(numeric.flag.length + 1) : tokens[i + 1]);
      if (parsed === undefined) {
        optionErrors.push(numeric.error);
      } else {
        options[numeric.key] = parsed;
        if (!inline) i++;
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
  if (options.resumeEditedWorkflow && !options.resumeFromRunId) optionErrors.push(INVALID_EDITED_RESUME_OPTION);
  return {
    args: kept.join(" ").trim(),
    options,
    ...(refreshDiscovery ? { refreshDiscovery } : {}),
    ...(optionErrors.length > 0 ? { optionErrors } : {}),
  };
}

function compactInlinePreview(script: string | undefined): string {
  if (!script) return "";
  const compact = script.replace(/\s+/g, " ").trim();
  return truncateText(compact, 60);
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

export async function pickWorkflow(
  workflows: ReadonlyMap<string, WorkflowModule>,
  ctx: ExtensionCommandContext,
): Promise<WorkflowInvocation | undefined> {
  const name = await selectWorkflowValue(workflows, ctx);
  if (!name) return undefined;

  if (name === AUTHOR_TEMP_WORKFLOW_VALUE) {
    const brief = await ctx.ui.editor(
      "Describe temporary workflow",
      "Goal:\n\nAgents to run:\n- \n\nFinal output should include:\n- summary\n- findings\n- next steps\n",
    );
    const trimmed = brief?.trim();
    if (!trimmed) return undefined;
    return { name: "", args: "", options: {}, authorBrief: trimmed };
  }

  if (name !== "code-review") return { name, args: "", options: {} };
  // Escape resolves undefined and cancels; only a submitted blank target means auto-detect.
  const target = await ctx.ui.input("Code-review target/instructions", "Blank = auto-detect diff");
  return target === undefined ? undefined : { name, args: target.trim(), options: {} };
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

function sendWorkflowExecution(pi: ExtensionAPI, execution: WorkflowExecution): void {
  pi.sendMessage(
    {
      customType: "workflow-result",
      content: formatMessageContent(execution.envelope),
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
      const execution = await executeResolvedWorkflow(pi, ctx, name, workflow, "", options, perfRecorder);
      reviewSessions.remember(ctx, execution, options);
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
    return renderWorkflowResult(isWorkflowResult(details) ? details : { name: "workflow", result: details ?? message.content }, expanded, theme);
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
        dynamax.markOneShot(ctx);
        pi.sendUserMessage(buildTemporaryWorkflowAuthorPrompt(invocation.authorBrief));
        return;
      }

      const mod = workflows.get(invocation.name);
      if (!mod) {
        ctx.ui.notify(`Unknown workflow "${invocation.name}". Available: ${available}`, "error");
        return;
      }

      // A picked invocation only exists for a blank command line, so its options equal the already-resolved defaults.
      await sendWorkflowResult(pi, ctx, invocation.name, mod, invocation.args, directOptions, perfRecorder, reviewSessions);
    },
  });

  registerWorkflowTool(pi, reviewSessions, backgroundWorkflows);
}

/** Register the host-facing workflow tool independently from command and lifecycle surfaces. */
function registerWorkflowTool(
  pi: ExtensionAPI,
  reviewSessions: ReviewSessionCoordinator,
  backgroundWorkflows: BackgroundWorkflowCoordinator,
): void {
  pi.registerTool({
    name: "workflow",
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
      const suffix = args.args ? ` ${theme.fg("dim", args.args)}` : "";
      const background = args.background ? ` ${theme.fg("dim", "(background)")}` : "";
      if (args.name?.trim()) {
        return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", args.name.trim())}${background}${suffix}`, 0, 0);
      }
      const preview = compactInlinePreview(args.script);
      const previewSuffix = preview ? ` ${theme.fg("dim", preview)}` : "";
      return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", "inline")}${background}${suffix}${previewSuffix}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "Running workflow…"), 0, 0);
      const details = result.details;
      if (isWorkflowResult(details)) return renderWorkflowResult(details, expanded, theme);
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
            const execution = await executeResolvedWorkflow(
              pi,
              backgroundCtx,
              resultName,
              mod,
              resultArgs,
              backgroundOptions,
              perfRecorder,
            );
            reviewSessions.remember(ctx, execution, backgroundOptions);
          },
        });
      }
      const execution = await executeResolvedWorkflow(pi, ctx, resultName, mod, resultArgs, runOptions, perfRecorder);
      reviewSessions.remember(ctx, execution, runOptions);
      return {
        content: [{ type: "text", text: formatMessageContent(execution.envelope) }],
        details: execution.envelope,
      };
    },
  });
}
