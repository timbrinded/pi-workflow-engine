import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DynamaxState {
  sticky: boolean;
  oneShotPending: boolean;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;

export const DYNAMAX_REMINDER = `
## dynamax workflow opt-in

The user has opted into dynamax multi-agent orchestration. The workflow tool is permitted for this task. You may either run an existing named workflow or author a new inline workflow script when that best serves the user's request.

Inline workflow rules:
- Use the injected Type object for schemas, for example Type.Object({ ok: Type.Boolean() }); do not import typebox.
- Do not use import statements or dynamic import() in inline workflow scripts.
- Set thinkingLevel explicitly on each agent() call so fan-out remains bounded.
- Provide exactly one of workflow.name or workflow.script.
`;

const DYNAMAX_CONTEXT_CUSTOM_TYPE = "workflow-dynamax-reminder";

export function createDynamaxState(): DynamaxState {
  return { sticky: false, oneShotPending: false };
}

export function hasDynamaxToken(text: string): boolean {
  return DYNAMAX_TOKEN_PATTERN.test(text);
}

export function markDynamaxOneShot(state: DynamaxState): void {
  state.oneShotPending = true;
}

export function setDynamaxSticky(state: DynamaxState, sticky: boolean): void {
  state.sticky = sticky;
  if (!sticky) state.oneShotPending = false;
}

export function clearDynamax(state: DynamaxState): void {
  state.sticky = false;
  state.oneShotPending = false;
}

export function consumeDynamaxOneShot(state: DynamaxState): boolean {
  const pending = state.oneShotPending;
  state.oneShotPending = false;
  return pending;
}

export function isDynamaxActive(state: DynamaxState): boolean {
  return state.sticky || state.oneShotPending;
}

export function appendDynamaxSystemReminder(systemPrompt: string, state: DynamaxState): string {
  if (!isDynamaxActive(state)) return systemPrompt;
  state.oneShotPending = false;
  return `${systemPrompt}\n\n${DYNAMAX_REMINDER.trim()}`;
}

export function appendDynamaxContextReminder(messages: AgentMessage[], state: DynamaxState): AgentMessage[] {
  if (!state.sticky) return messages;
  return [...messages, createDynamaxContextMessage()];
}

export function registerDynamax(pi: ExtensionAPI): void {
  const state = createDynamaxState();

  pi.on("input", (event) => {
    if (event.source === "extension") return { action: "continue" };
    if (hasDynamaxToken(event.text)) markDynamaxOneShot(state);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event) => {
    const systemPrompt = appendDynamaxSystemReminder(event.systemPrompt, state);
    if (systemPrompt === event.systemPrompt) return undefined;
    return { systemPrompt };
  });

  pi.on("context", (event) => {
    const messages = appendDynamaxContextReminder(event.messages, state);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  pi.registerCommand("workflow:dynamax", {
    description: "Toggle dynamax workflow orchestration opt-in: /workflow:dynamax on|off|status",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "on") {
        setDynamaxSticky(state, true);
        ctx.ui.notify("dynamax workflow orchestration is on for this session", "info");
        return;
      }
      if (action === "off") {
        clearDynamax(state);
        ctx.ui.notify("dynamax workflow orchestration is off", "info");
        return;
      }
      if (action === "status") {
        const sticky = state.sticky ? "on" : "off";
        const oneShot = state.oneShotPending ? "; one-shot opt-in pending" : "";
        ctx.ui.notify(`dynamax sticky mode is ${sticky}${oneShot}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /workflow:dynamax on|off|status", "warning");
    },
  });
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
