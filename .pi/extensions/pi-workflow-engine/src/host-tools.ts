import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import { defineTool, type ExtensionToolContext, type ToolDefinition, type ToolInfo } from "@earendil-works/pi-coding-agent";

/** pi names MCP tools `mcp__<server>__<tool>`. */
const MCP_TOOL_PREFIX = "mcp__";

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Host-only tools a subagent can reach through the host session. Subagents are SDK sessions, which
 * load none of pi's built-in extensions, so they connect no MCP servers of their own; proxies call the
 * host's tools over its existing connections and through its `tool_call` permission handlers.
 */
export interface HostToolBridge {
  /** Callable host MCP tools, read as each agent starts so servers that connected mid-run are included. */
  tools(): readonly ToolInfo[];
  execute(name: string, args: unknown, signal: AbortSignal | undefined): Promise<AgentToolCallOutcome>;
}

/**
 * `executeTool` exists only while the host's tool call runs, so only a synchronous `workflow` tool run
 * gets a bridge; `/workflow` commands and background runs that outlive the call do not.
 */
export function createHostToolBridge(
  registeredTools: () => readonly ToolInfo[],
  ctx: Pick<ExtensionToolContext, "tools" | "executeTool">,
): HostToolBridge {
  return {
    tools() {
      const callable = new Set(ctx.tools.map((tool) => tool.name));
      return registeredTools().filter((tool) => isMcpToolName(tool.name) && callable.has(tool.name));
    },
    execute: (name, args, signal) => ctx.executeTool(name, args, { signal }),
  };
}

/**
 * A subagent tool that runs the host tool. It reports no usage: pi already adds nested calls' usage to
 * the host's `workflow` tool result.
 */
export function hostToolProxy(tool: ToolInfo, bridge: HostToolBridge): ToolDefinition {
  return defineTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    promptGuidelines: tool.promptGuidelines,
    namespace: tool.namespace,
    annotations: tool.annotations,
    async execute(_toolCallId, params, signal) {
      const outcome = await bridge.execute(tool.name, params, signal);
      return { content: outcome.result.content, details: undefined, ...(outcome.isError ? { isError: true } : {}) };
    },
  });
}
