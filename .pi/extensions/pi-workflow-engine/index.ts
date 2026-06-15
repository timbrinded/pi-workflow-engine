import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkflowProgressSnapshot } from "./src/progress.ts";
import type { WorkflowModule, WorkflowRef, WorkflowRunOptions } from "./src/types.ts";
import { WorkflowInspector } from "./src/ui/workflow-inspector.ts";
import type { PerfSink, PerfSnapshot } from "./src/perf.ts";
import { registerDynamax } from "./src/dynamax.ts";
import { handleReviewViewerAction } from "./src/review/review-actions.ts";
import { decideReviewResultsPresentation, extensionContextMode, maybeShowReviewResultsViewer } from "./src/review/review-results-flow.ts";
import { isWorkflowResult, renderWorkflowResult, type WorkflowPerfDetails, type WorkflowResultEnvelope } from "./src/ui/workflow-result-renderer.ts";

/** Extension root (this file lives in <repo>/.pi/extensions/pi-workflow-engine/index.ts). */
const EXTENSION_DIR = fileURLToPath(new URL(".", import.meta.url));

function summarize(result: unknown): string {
  if (result && typeof result === "object" && typeof (result as { summary?: unknown }).summary === "string") {
    return (result as { summary: string }).summary;
  }
  return typeof result === "string" ? result : "Workflow finished.";
}

function formatMessageContent(name: string, result: unknown, perf?: WorkflowPerfDetails): string {
  const perfLine = formatPerfLine(perf);
  return `## Workflow: ${name}\n\n${summarize(result)}${perfLine ? `\n\n${perfLine}` : ""}`;
}

function workflowEnvelope(name: string, result: unknown, perf?: WorkflowPerfDetails): WorkflowResultEnvelope {
  return { name, result, completedAt: Date.now(), perf };
}

function compactPerfSnapshot(snapshot: PerfSnapshot | undefined): WorkflowPerfDetails | undefined {
  if (!snapshot?.enabled) return undefined;
  return { enabled: true, startedAt: snapshot.startedAt, aggregates: snapshot.aggregates };
}

function formatPerfLine(perf: WorkflowPerfDetails | undefined): string | undefined {
  if (!perf) return undefined;
  const parts = perf.aggregates.slice(0, 4).map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `Perf: ${parts.join(" · ")}` : "Perf: no samples";
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
 * Resolve an `api.workflow()` reference to a module: a registered name via discovery, or an
 * inline-style script file via `{ scriptPath }` (no imports; uses injected `Type`). Throws on an
 * unknown name, a scriptPath outside the repo, an unreadable file, or an inline compile error.
 */
export async function resolveWorkflowRef(cwd: string, ref: WorkflowRef, perf?: PerfSink): Promise<WorkflowModule> {
  if (typeof ref !== "string") {
    const root = resolve(cwd);
    const abs = resolve(root, ref.scriptPath);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`sub-workflow scriptPath escapes the repo: ${ref.scriptPath}`);
    }
    const source = await readFile(abs, "utf8");
    const { compileInlineWorkflow } = await loadInlineWorkflow();
    return compileInlineWorkflow(source);
  }
  const { discoverWorkflows } = await loadDiscovery();
  const workflows = await discoverWorkflows(EXTENSION_DIR, { perf });
  const mod = workflows.get(ref);
  if (!mod) {
    const available = [...workflows.keys()].join(", ") || "(none)";
    throw new Error(`Unknown workflow "${ref}". Available: ${available}`);
  }
  return mod;
}

const AUTHOR_TEMP_WORKFLOW_CHOICE = "✍ Author temporary one-shot workflow…";

export interface LastWorkflowInspection {
  readonly name: string;
  readonly args: string;
  readonly completedAt: number;
  readonly snapshot: WorkflowProgressSnapshot;
}

let lastWorkflowInspection: LastWorkflowInspection | undefined;

export function getLastWorkflowInspection(): LastWorkflowInspection | undefined {
  return lastWorkflowInspection;
}

export async function openWorkflowInspector(ctx: ExtensionCommandContext, inspection: LastWorkflowInspection): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => new WorkflowInspector(() => inspection.snapshot, tui, theme, () => done(undefined)),
    { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
  );
}

export interface WorkflowInvocation {
  name: string;
  args: string;
  options: WorkflowRunOptions;
  refreshDiscovery?: boolean;
  authorBrief?: string;
}

export function parseWorkflowInvocation(input: string): WorkflowInvocation {
  const trimmed = input.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const { args, options, refreshDiscovery } = parseWorkflowOptions(rest);
  return { name, args, options, refreshDiscovery };
}

function parseWorkflowOptions(input: string): { args: string; options: WorkflowRunOptions; refreshDiscovery?: boolean } {
  const tokens = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const options: WorkflowRunOptions = {};
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
    kept.push(token);
  }
  return { args: kept.join(" ").trim(), options, refreshDiscovery: refreshDiscovery || undefined };
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
Do not edit files unless the user explicitly requested edits.`;
}

export interface WorkflowToolRequestParams {
  readonly name?: string;
  readonly script?: string;
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
  const choices = [AUTHOR_TEMP_WORKFLOW_CHOICE, ...[...workflows.values()].map((mod) => `${mod.meta.name} — ${mod.meta.description}`)];
  const choice = await ctx.ui.select("Run workflow", choices);
  if (!choice) return undefined;

  if (choice === AUTHOR_TEMP_WORKFLOW_CHOICE) {
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
  ctx: ExtensionCommandContext,
  name: string,
  mod: WorkflowModule,
  args: string,
  options: WorkflowRunOptions,
  perfRecorder?: PerfSink,
): Promise<void> {
  const { runWorkflow } = await loadEngine();
  let perfSnapshot: PerfSnapshot | undefined;
  const result = await runWorkflow(ctx, mod, args, {
    ...options,
    perf: options.perf ?? perfRecorder !== undefined,
    perfRecorder,
    resolveWorkflow: (ref) => resolveWorkflowRef(ctx.cwd, ref, perfRecorder),
    onPerfSnapshot(snapshot) {
      perfSnapshot = snapshot;
      options.onPerfSnapshot?.(snapshot);
    },
    onProgressSnapshot(snapshot) {
      lastWorkflowInspection = { name, args, completedAt: snapshot.doneAt ?? Date.now(), snapshot };
      options.onProgressSnapshot?.(snapshot);
    },
  });
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
  if (reviewDecision.kind !== "send") {
    await handleReviewViewerAction(pi, ctx, reviewAction, reviewDecision.issues, reviewDecision.report.reviewContext);
  }
  pi.sendMessage(
    { customType: "workflow-result", content: formatMessageContent(name, result, perf), display: true, details: workflowEnvelope(name, result, perf) },
    { triggerTurn: false },
  );
}

export default function workflowEngine(pi: ExtensionAPI): void {
  registerDynamax(pi);

  pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (isWorkflowResult(details)) return renderWorkflowResult(details.name, details.result, expanded, theme);
    return renderWorkflowResult("workflow", details ?? message.content, expanded, theme);
  });

  pi.registerCommand("workflow:inspector", {
    description: "Open the last completed workflow inspector",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      if (trimmed && trimmed !== "last") {
        ctx.ui.notify("Usage: /workflow:inspector [last]", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Workflow inspector requires the TUI", "warning");
        return;
      }
      const inspection = lastWorkflowInspection;
      if (!inspection) {
        ctx.ui.notify("No completed workflow inspector is available yet", "warning");
        return;
      }
      await openWorkflowInspector(ctx, inspection);
    },
  });

  // /workflow <name> [args] — user-invoked.
  pi.registerCommand("workflow", {
    description: "Run a multi-agent workflow: /workflow <name> [args]",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const direct = parseWorkflowInvocation(args);
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
      "Every workflow tool call must provide exactly one of `name` or `script`, never both.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Workflow name, e.g. code-review. Provide exactly one of name or script." })),
      script: Type.Optional(Type.String({ description: "Inline workflow script. Provide exactly one of script or name." })),
      args: Type.Optional(Type.String({ description: "Arguments for the workflow (e.g. target or focus)" })),
      concurrency: Type.Optional(Type.Number({ description: "Optional per-run agent concurrency cap" })),
      parallelSubmissionLimit: Type.Optional(Type.Number({ description: "Optional limit for eagerly submitted parallel thunks" })),
      perf: Type.Optional(Type.Boolean({ description: "Include workflow performance timing aggregates in the result details" })),
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
      if (isWorkflowResult(details)) return renderWorkflowResult(details.name, details.result, expanded, theme);
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Workflow finished.";
      return new Text(theme.fg("muted", text), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const request = normalizeWorkflowToolRequest(params);
      if (request.kind === "error") return invalidWorkflowInvocationResult();

      const runOptions: WorkflowRunOptions = {
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        perf: params.perf,
        signal,
      };
      const perfRecorder = await createInvocationPerf(runOptions);
      let mod: WorkflowModule;
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
      const result = await runWorkflow(ctx, mod, params.args ?? "", {
        ...runOptions,
        perf: runOptions.perf ?? perfRecorder !== undefined,
        perfRecorder,
        resolveWorkflow: (ref) => resolveWorkflowRef(ctx.cwd, ref, perfRecorder),
        onPerfSnapshot: (snapshot) => {
          perfSnapshot = snapshot;
        },
      });
      const perf = compactPerfSnapshot(perfSnapshot);
      const perfLine = formatPerfLine(perf);
      return { content: [{ type: "text", text: `${summarize(result)}${perfLine ? `\n\n${perfLine}` : ""}` }], details: workflowEnvelope(resultName, result, perf) };
    },
  });
}
