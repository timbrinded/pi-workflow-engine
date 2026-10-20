export interface WorkflowToolRequestParams {
  readonly name?: string;
  readonly script?: string;
  readonly scriptPath?: string;
  readonly resumeFromRunId?: string;
  readonly background?: boolean;
}

export type WorkflowToolRequest =
  | { readonly kind: "named"; readonly name: string }
  | { readonly kind: "inline"; readonly script: string }
  | { readonly kind: "script-path"; readonly scriptPath: string }
  | { readonly kind: "error"; readonly error: "invalid_workflow_invocation"; readonly message: string };

export const INVALID_WORKFLOW_INVOCATION_MESSAGE = "Provide exactly one of a workflow name, an inline workflow script, or a scriptPath.";

export function normalizeWorkflowToolRequest(params: WorkflowToolRequestParams): WorkflowToolRequest {
  const name = params.name?.trim() ?? "";
  const script = params.script?.trim() ?? "";
  const scriptPath = params.scriptPath?.trim() ?? "";
  const provided = [name, script, scriptPath].filter((value) => value.length > 0).length;
  if (provided !== 1) return { kind: "error", error: "invalid_workflow_invocation", message: INVALID_WORKFLOW_INVOCATION_MESSAGE };
  if (name) return { kind: "named", name };
  return script ? { kind: "inline", script } : { kind: "script-path", scriptPath };
}

/** pi names MCP tools `mcp__<server>__<tool>`; such a word contains its server's `mcp__<server>` namespace. */
const MCP_TOOL_REFERENCE = /mcp__[A-Za-z0-9_-]+/g;
/** `api.workflow(...)` or a destructured `workflow(...)`; prose that happens to match only costs one wait. */
const SUB_WORKFLOW_CALL = /\bworkflow\s*\(/;

/**
 * Which tools a `workflow` tool call may reach, for pi's `reachesTools`, read from the same request the
 * call executes. Before the call runs, pi's MCP extension waits for every server whose namespace a
 * returned word contains, or for all of them on `"all"`. Without that wait a synchronous run early in a
 * session can start before MCP tools register, and agents that name them then fail at the host-tools bridge.
 *
 * - A background run never gets the bridge, so it reaches nothing.
 * - A named workflow is opaque, so it reaches `"all"`. Each server's readiness settles once, so this
 *   costs at most one wait at session start.
 * - An inline script reaches the MCP tools it names, or `"all"` when it asks for `external-search`
 *   tools or composes a sub-workflow, which is as opaque as a named one.
 * - A script file reaches `"all"` unread. pi asks synchronously on its main thread, where reading a FIFO,
 *   a terminal or a device named as `scriptPath` would block or never end.
 * - An invalid call fails before running anything, so it reaches nothing.
 */
export function workflowToolReach(input: Record<string, unknown>): "all" | readonly string[] {
  if (input.background === true) return [];
  const request = normalizeWorkflowToolRequest({ name: text(input.name), script: text(input.script), scriptPath: text(input.scriptPath) });
  if (request.kind === "inline") return scriptReach(request.script);
  return request.kind === "error" ? [] : "all";
}

function scriptReach(script: string): "all" | readonly string[] {
  if (script.includes("external-search") || SUB_WORKFLOW_CALL.test(script)) return "all";
  return [...new Set(script.match(MCP_TOOL_REFERENCE) ?? [])];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
