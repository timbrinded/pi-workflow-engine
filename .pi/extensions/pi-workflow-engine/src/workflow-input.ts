// A workflow's input is the string a slash command passes, or any JSON value from a tool call or
// `api.workflow()`. Workflows read it verbatim as `api.input` and as text as `api.args`.

/** `api.args`: a string verbatim, any other JSON value as JSON text, and "" when nothing was passed. */
export function workflowArgsText(input: unknown): string {
  if (typeof input === "string") return input;
  return JSON.stringify(input) ?? "";
}

/** Whether a run had arguments. Run records never keep them, so such a run cannot be relaunched. */
export function workflowInputPresent(input: unknown): boolean {
  return input !== undefined && input !== "";
}
