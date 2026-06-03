import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { discoverWorkflows } from "./discovery.ts";
import { runWorkflow } from "./engine.ts";
import type { WorkflowModule, WorkflowRunOptions } from "./types.ts";
import { isWorkflowResult, renderWorkflowResult, type WorkflowResultEnvelope } from "./ui/workflow-result-renderer.ts";

/** Repo root (this file lives in <repo>/src/index.ts). */
const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));

function summarize(result: unknown): string {
  if (result && typeof result === "object" && typeof (result as { summary?: unknown }).summary === "string") {
    return (result as { summary: string }).summary;
  }
  return typeof result === "string" ? result : "Workflow finished.";
}

function formatReport(name: string, result: unknown): string {
  return [`## Workflow: ${name}`, "", "```json", JSON.stringify(result, null, 2), "```"].join("\n");
}

function workflowEnvelope(name: string, result: unknown): WorkflowResultEnvelope {
  return { name, result, completedAt: Date.now() };
}

interface WorkflowInvocation {
  name: string;
  args: string;
  options: WorkflowRunOptions;
}

function parseWorkflowInvocation(input: string): WorkflowInvocation {
  const trimmed = input.trim();
  const space = trimmed.indexOf(" ");
  const name = space === -1 ? trimmed : trimmed.slice(0, space);
  const rest = space === -1 ? "" : trimmed.slice(space + 1).trim();
  const inspect = /(?:^|\s)--inspect(?:\s|$)/.test(rest);
  const cleanedArgs = rest.replace(/(?:^|\s)--inspect(?=\s|$)/g, " ").trim();
  return { name, args: cleanedArgs, options: inspect ? { inspect: true } : {} };
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
): Promise<void> {
  const result = await runWorkflow(ctx, mod, args, options);
  pi.sendMessage(
    { customType: "workflow-result", content: formatReport(name, result), display: true, details: workflowEnvelope(name, result) },
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
      const workflows = await discoverWorkflows(REPO_DIR);
      const available = [...workflows.keys()].join(", ") || "(none)";
      const direct = parseWorkflowInvocation(args);
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

      await sendWorkflowResult(pi, ctx, invocation.name, mod, invocation.args, invocation.options);
    },
  });

  // workflow tool — lets the host agent fan out mid-conversation.
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a named multi-agent workflow (fan-out → verify → synthesize) and return its structured result. Use for thorough reviews or audits.",
    parameters: Type.Object({
      name: Type.String({ description: "Workflow name, e.g. code-review" }),
      args: Type.Optional(Type.String({ description: "Arguments for the workflow (e.g. target or focus)" })),
    }),
    renderCall(args, theme) {
      const suffix = args.args ? ` ${theme.fg("dim", args.args)}` : "";
      return new Text(`▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", args.name)}${suffix}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      if (isPartial) return new Text(theme.fg("accent", "Running workflow…"), 0, 0);
      const details = result.details;
      if (isWorkflowResult(details)) return renderWorkflowResult(details.name, details.result, expanded, theme);
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "Workflow finished.";
      return new Text(theme.fg("muted", text), 0, 0);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const workflows = await discoverWorkflows(REPO_DIR);
      const mod = workflows.get(params.name);
      if (!mod) {
        const available = [...workflows.keys()].join(", ") || "(none)";
        return {
          content: [{ type: "text", text: `Unknown workflow "${params.name}". Available: ${available}` }],
          details: { error: "unknown_workflow", available },
        };
      }
      const result = await runWorkflow(ctx, mod, params.args ?? "");
      return { content: [{ type: "text", text: summarize(result) }], details: workflowEnvelope(params.name, result) };
    },
  });
}
