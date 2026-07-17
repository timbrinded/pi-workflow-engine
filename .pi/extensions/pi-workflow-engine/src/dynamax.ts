import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./dynamax-shortcuts.ts";

export interface DynamaxState {
  sticky: boolean;
  oneShotPending: boolean;
  turnActive: boolean;
}

export interface DynamaxRuntime {
  state: DynamaxState;
  runningWorkflow?: string;
}

export type DynamaxRuntimeStore = Map<string, DynamaxRuntime>;
export interface DynamaxRegistrationOptions {
  openInspector?: (ctx: ExtensionContext) => Promise<void> | void;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;
export const DYNAMAX_STATUS_KEY = "dynamax";
export const DYNAMAX_WIDGET_KEY = "workflow-dynamax";

export const ADAPTIVE_WORKFLOW_GUIDANCE = `
Adaptive multi-pass workflows are optional. Use a simple single-pass fan-out when it is sufficient. When the first pass may expose gaps, conflicts, weak claims, or missing evidence:
- run the bounded first-pass agents;
- give their surviving results to a structured gap-analysis agent so the LLM decides what needs follow-up;
- put a hard maxItems bound on LLM-authored task arrays and defensively slice them before fan-out;
- use ordinary TypeScript conditionals or bounded loops to launch follow-up agents only when gaps exist;
- synthesize the first-pass and follow-up results together.
Do not generate a second pass when the first pass is sufficient, and do not invent iteration, quorum, graph, reduction, or retry primitives for this pattern.`;

export const DYNAMAX_REMINDER = `
## dynamax workflow opt-in

The user has opted into dynamax multi-agent orchestration. The workflow tool is permitted for this task. You may either run an existing named workflow or author a new inline workflow script when that best serves the user's request.

Inline workflow rules:
- Use the injected Type object for schemas, for example Type.Object({ ok: Type.Boolean() }); do not import typebox.
- Do not use import statements or dynamic import() in inline workflow scripts.
- Set thinkingLevel explicitly on each agent() call so fan-out remains bounded.
- Subagents receive no skills by default. Add \`skills: ["skill-name"]\` per agent only when that stage should load that skill; grant the smallest useful set.
- Provide exactly one of workflow.name or workflow.script.

${ADAPTIVE_WORKFLOW_GUIDANCE}
`;

const DYNAMAX_CONTEXT_CUSTOM_TYPE = "workflow-dynamax-reminder";

export function createDynamaxState(): DynamaxState {
  return { sticky: false, oneShotPending: false, turnActive: false };
}

export function createDynamaxRuntime(): DynamaxRuntime {
  return { state: createDynamaxState() };
}

export function dynamaxSessionKey(ctx: Pick<ExtensionContext, "sessionManager">): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

export function getDynamaxRuntime(store: DynamaxRuntimeStore, ctx: Pick<ExtensionContext, "sessionManager">): DynamaxRuntime {
  const key = dynamaxSessionKey(ctx);
  const existing = store.get(key);
  if (existing) return existing;
  const runtime = createDynamaxRuntime();
  store.set(key, runtime);
  return runtime;
}

export function hasDynamaxToken(text: string): boolean {
  return DYNAMAX_TOKEN_PATTERN.test(text);
}

export function markDynamaxOneShot(state: DynamaxState): void {
  state.oneShotPending = true;
}

export function setDynamaxSticky(state: DynamaxState, sticky: boolean): void {
  state.sticky = sticky;
  if (!sticky) {
    state.oneShotPending = false;
    state.turnActive = false;
  }
}

export function clearDynamax(state: DynamaxState): void {
  state.sticky = false;
  state.oneShotPending = false;
  state.turnActive = false;
}

export function consumeDynamaxOneShot(state: DynamaxState): boolean {
  const pending = state.oneShotPending;
  state.oneShotPending = false;
  return pending;
}

export function isDynamaxActive(state: DynamaxState): boolean {
  return state.sticky || state.oneShotPending || state.turnActive;
}

export function describeDynamaxState(state: DynamaxState): string {
  const sticky = state.sticky ? "on" : "off";
  const oneShot = state.oneShotPending ? "pending" : "clear";
  const turn = state.turnActive ? "; active for current turn" : "";
  return `sticky ${sticky}; one-shot ${oneShot}${turn}`;
}

export function dynamaxWidgetLine(state: DynamaxState, shortcut: KeyId | null, runningWorkflow?: string): string {
  const modes = [
    runningWorkflow ? `running ${runningWorkflow}` : undefined,
    state.sticky ? "sticky on" : undefined,
    !state.sticky && state.turnActive ? "active this turn" : undefined,
    state.oneShotPending ? "one-shot pending" : undefined,
  ].filter((value): value is string => value !== undefined);
  const mode = modes.join(" + ") || "off";
  const inspectorHint = shortcut ? `${shortcut} inspector` : "/workflow:inspector";
  return `dynamax: ${mode} | /workflow:dynamax on|off | ${inspectorHint}`;
}

export function appendDynamaxSystemReminder(systemPrompt: string, state: DynamaxState): string {
  if (!state.sticky && !state.oneShotPending) return systemPrompt;
  state.oneShotPending = false;
  state.turnActive = true;
  return `${systemPrompt}\n\n${DYNAMAX_REMINDER.trim()}`;
}

export function appendDynamaxContextReminder(messages: AgentMessage[], state: DynamaxState): AgentMessage[] {
  if (!state.sticky) return messages;
  return [...messages, createDynamaxContextMessage()];
}

export function registerDynamax(
  pi: ExtensionAPI,
  shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts(),
  options: DynamaxRegistrationOptions = {},
): void {
  const runtimes: DynamaxRuntimeStore = new Map();
  const openInspector =
    options.openInspector ??
    ((ctx: ExtensionContext): void => {
      ctx.ui.notify("No workflow inspector is available yet", "warning");
    });
  const refreshIfVisible = (ctx: ExtensionContext): void => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (isDynamaxActive(runtime.state) || runtime.runningWorkflow) {
      updateDynamaxSurfaces(ctx, runtime, shortcuts);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    updateDynamaxSurfaces(ctx, getDynamaxRuntime(runtimes, ctx), shortcuts);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearDynamaxSurfaces(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (hasDynamaxToken(event.text)) {
      markDynamaxOneShot(runtime.state);
      updateDynamaxSurfaces(ctx, runtime, shortcuts);
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    const systemPrompt = appendDynamaxSystemReminder(event.systemPrompt, runtime.state);
    if (systemPrompt === event.systemPrompt) return undefined;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return { systemPrompt };
  });

  pi.on("agent_start", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_start", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_update", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_end", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    runtime.runningWorkflow = undefined;
    if (!runtime.state.sticky) runtime.state.turnActive = false;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (event.toolName === "workflow") {
      runtime.runningWorkflow = workflowLabel(event.args);
    }
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return undefined;
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (event.toolName === "workflow") {
      runtime.runningWorkflow = undefined;
    }
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return undefined;
  });

  pi.on("context", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    const messages = appendDynamaxContextReminder(event.messages, runtime.state);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  if (shortcuts.inspector) {
    pi.registerShortcut(shortcuts.inspector, {
      description: "Open workflow inspector",
      handler: async (ctx) => {
        await openInspector(ctx);
      },
    });
  }

  pi.registerCommand("workflow:dynamax", {
    description: "Toggle Dynamax workflow orchestration: /workflow:dynamax [on|off|status]",
    handler: async (args, ctx) => {
      const runtime = getDynamaxRuntime(runtimes, ctx);
      const action = args.trim().toLowerCase();
      if (action === "") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}. Usage: /workflow:dynamax [on|off|status]`, "info");
        return;
      }
      if (action === "on") {
        setDynamaxSticky(runtime.state, true);
        updateDynamaxSurfaces(ctx, runtime, shortcuts);
        ctx.ui.notify("Dynamax workflow orchestration is on for this session", "info");
        return;
      }
      if (action === "off") {
        clearDynamax(runtime.state);
        updateDynamaxSurfaces(ctx, runtime, shortcuts);
        ctx.ui.notify("Dynamax workflow orchestration is off", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /workflow:dynamax [on|off|status]", "warning");
    },
  });
}

export function updateDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">, runtime: DynamaxRuntime, shortcuts: DynamaxShortcuts): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(DYNAMAX_WIDGET_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_WIDGET_KEY, undefined);
  if (!isDynamaxActive(runtime.state) && !runtime.runningWorkflow) {
    clearDynamaxSurfaces(ctx);
    return;
  }

  const status = dynamaxWidgetLine(runtime.state, shortcuts.inspector, runtime.runningWorkflow);
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, status);
}

export function clearDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(DYNAMAX_WIDGET_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_WIDGET_KEY, undefined);
}

function workflowLabel(args: unknown): string {
  if (!isRecord(args)) return "workflow";
  const name = args.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const script = args.script;
  if (typeof script === "string" && script.trim()) return "inline workflow";
  return "workflow";
}

function createDynamaxContextMessage(): AgentMessage {
  return {
    role: "custom",
    customType: DYNAMAX_CONTEXT_CUSTOM_TYPE,
    content: DYNAMAX_REMINDER.trim(),
    display: false,
    details: { dynamax: true, sticky: true },
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
