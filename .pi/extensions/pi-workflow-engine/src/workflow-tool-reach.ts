/** pi names MCP tools `mcp__<server>__<tool>`; such a word contains its server's `mcp__<server>` namespace. */
const MCP_TOOL_REFERENCE = /mcp__[A-Za-z0-9_-]+/g;
/** `api.workflow(...)` or a destructured `workflow(...)`; prose that happens to match only costs one wait. */
const SUB_WORKFLOW_CALL = /\bworkflow\s*\(/;

/**
 * Which tools a `workflow` tool call may reach, for pi's `reachesTools`. Before the call runs, pi's MCP
 * extension waits for every server whose namespace a returned word contains, or for all of them on
 * `"all"`. Without that wait a synchronous run early in a session can start before MCP tools register,
 * and agents that name them then fail at the host-tools bridge.
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
  const name = nonEmptyString(input.name);
  const script = nonEmptyString(input.script);
  const scriptPath = nonEmptyString(input.scriptPath);
  if (name !== undefined) return script === undefined && scriptPath === undefined ? "all" : [];
  if (script !== undefined) return scriptPath === undefined ? scriptReach(script) : [];
  return scriptPath === undefined ? [] : "all";
}

function scriptReach(script: string): "all" | readonly string[] {
  if (script.includes("external-search") || SUB_WORKFLOW_CALL.test(script)) return "all";
  return [...new Set(script.match(MCP_TOOL_REFERENCE) ?? [])];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
