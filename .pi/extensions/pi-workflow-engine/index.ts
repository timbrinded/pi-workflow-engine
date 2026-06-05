import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { WorkflowModule, WorkflowRunOptions } from "./src/types.ts";
import type { PerfSink, PerfSnapshot } from "./src/perf.ts";
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

export interface WorkflowInvocation {
  name: string;
  args: string;
  options: WorkflowRunOptions;
  refreshDiscovery?: boolean;
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

async function pickWorkflow(
  workflows: ReadonlyMap<string, WorkflowModule>,
  ctx: ExtensionCommandContext,
): Promise<WorkflowInvocation | undefined> {
  const choices = [...workflows.values()].map((mod) => `${mod.meta.name} — ${mod.meta.description}`);
  const choice = await ctx.ui.select("Run workflow", choices);
  if (!choice) return undefined;

  const separator = choice.indexOf(" — ");
  const name = separator === -1 ? choice : choice.slice(0, separator);
  const args = name === "code-review" ? (await ctx.ui.input("Code-review target/instructions", "Blank = auto-detect diff"))?.trim() ?? "" : "";
  const inspect = await ctx.ui.confirm("Open inspector?", "Open a live workflow inspector while this workflow runs?");
  return { name, args, options: { inspect } };
}

async function sendWorkflowResult(
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
    onPerfSnapshot(snapshot) {
      perfSnapshot = snapshot;
      options.onPerfSnapshot?.(snapshot);
    },
  });
  const perf = compactPerfSnapshot(perfSnapshot);
  pi.sendMessage(
    { customType: "workflow-result", content: formatMessageContent(name, result, perf), display: true, details: workflowEnvelope(name, result, perf) },
    { triggerTurn: false },
  );
}

export default function workflowEngine(pi: ExtensionAPI): void {
  pi.registerMessageRenderer("workflow-result", (message, { expanded }, theme) => {
    const details = message.details;
    if (isWorkflowResult(details)) return renderWorkflowResult(details.name, details.result, expanded, theme);
    return renderWorkflowResult("workflow", details ?? message.content, expanded, theme);
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
      "Run a named or inline multi-agent workflow (fan-out → verify → synthesize) and return its structured result. Use for thorough reviews or audits.",
    promptSnippet: "Run an existing named workflow or an inline one-off workflow script",
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
      const name = params.name?.trim() ?? "";
      const script = params.script?.trim() ?? "";
      const hasName = name.length > 0;
      const hasScript = script.length > 0;
      if (hasName === hasScript) {
        return {
          content: [{ type: "text", text: "Provide exactly one workflow name or inline workflow script." }],
          details: { error: "invalid_workflow_invocation" },
        };
      }

      const runOptions: WorkflowRunOptions = {
        concurrency: params.concurrency,
        parallelSubmissionLimit: params.parallelSubmissionLimit,
        perf: params.perf,
        signal,
      };
      const perfRecorder = await createInvocationPerf(runOptions);
      let mod: WorkflowModule;
      let resultName: string;

      if (hasName) {
        const { discoverWorkflows } = await loadDiscovery();
        const workflows = await discoverWorkflows(EXTENSION_DIR, { perf: perfRecorder });
        const named = workflows.get(name);
        if (!named) {
          const available = [...workflows.keys()].join(", ") || "(none)";
          return {
            content: [{ type: "text", text: `Unknown workflow "${name}". Available: ${available}` }],
            details: { error: "unknown_workflow", available },
          };
        }
        mod = named;
        resultName = name;
      } else {
        const inline = await loadInlineWorkflow();
        try {
          mod = inline.compileInlineWorkflow(script);
        } catch (error) {
          if (error instanceof inline.InlineWorkflowCompileError) {
            return {
              content: [{ type: "text", text: `Inline workflow did not compile: ${error.message}` }],
              details: { error: "inline_compile_error", message: error.message },
            };
          }
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
