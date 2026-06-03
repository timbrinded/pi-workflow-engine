import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentState } from "@earendil-works/pi-agent-core";
import type { AgentOptions } from "./types.ts";
import type { Semaphore } from "./concurrency.ts";
import type { ProgressTracker } from "./progress.ts";

/** Name of the synthetic terminating tool that carries structured output. */
const FINAL_TOOL = "final_answer";

/** Shared per-run context threaded into every agent() call. */
export interface RunContext {
  cwd: string;
  hostModel: Model<any> | undefined;
  modelRegistry: ModelRegistry;
  semaphore: Semaphore;
  progress: ProgressTracker;
  signal: AbortSignal | undefined;
}

/** Pull the last assistant message's plain text out of a finished session. */
function lastAssistantText(state: AgentState): string {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if ("role" in message && message.role === "assistant") {
      const content = (message as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      return content
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    }
  }
  return "";
}

/**
 * Run one subagent to completion in an isolated in-memory session.
 *
 * Structured output trick: when `opts.schema` is set we register a single
 * terminating tool whose `parameters` IS the schema. The agent's last action is to
 * call it; pi validates the args against the schema, hands them to `execute`, and
 * `terminate: true` ends the turn with no extra LLM round-trip. We capture those
 * validated args in a closure — that captured object is the structured result, so
 * no event-stream parsing is needed.
 */
export async function runAgent(rc: RunContext, prompt: string, opts: AgentOptions = {}): Promise<unknown> {
  const label = opts.label ?? "agent";

  // Acquire a global concurrency slot before spawning the session.
  return rc.semaphore.run(async () => {
    rc.progress.agentStart(opts.phase, label);

    let captured: unknown = null;
    const customTools: ToolDefinition[] = opts.schema
      ? [
          defineTool({
            name: FINAL_TOOL,
            label: "Final Answer",
            description:
              "Return your final structured answer. This MUST be your last action — do not write a normal reply after calling it.",
            parameters: opts.schema,
            async execute(_toolCallId, params) {
              captured = params;
              return { content: [{ type: "text", text: "Recorded." }], details: params, terminate: true };
            },
          }),
        ]
      : [];

    // When the workflow restricts built-in tools, keep the terminating tool visible.
    const allow = opts.tools
      ? opts.schema
        ? [...opts.tools, FINAL_TOOL]
        : opts.tools
      : undefined;

    // Resolve the model by runtime id lookup (no compile-time model-id union); fall back to the host's model.
    const model = opts.model ? rc.modelRegistry.find("anthropic", opts.model) ?? rc.hostModel : rc.hostModel;

    const { session } = await createAgentSession({
      cwd: rc.cwd,
      model,
      modelRegistry: rc.modelRegistry,
      thinkingLevel: opts.thinkingLevel,
      tools: allow,
      customTools,
      sessionManager: SessionManager.inMemory(rc.cwd),
    });

    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName !== FINAL_TOOL) {
        rc.progress.agentTool(label, event.toolName);
      }
    });

    try {
      const finalPrompt = opts.schema
        ? `${prompt}\n\nWhen finished, return your result by calling the ${FINAL_TOOL} tool.`
        : prompt;
      await session.prompt(finalPrompt);
      if (opts.schema) {
        if (captured === null) rc.progress.log(`${label}: no structured answer returned`);
        return captured;
      }
      return lastAssistantText(session.state);
    } catch (error) {
      rc.progress.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      unsubscribe();
      session.dispose();
      rc.progress.agentDone(label);
    }
  });
}
