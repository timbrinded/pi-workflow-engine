/** Parse a model ref: a bare id is Anthropic shorthand, otherwise "provider/id". Malformed refs throw. */
export function parseAgentModelRef(modelRef: string): { readonly provider: string; readonly id: string } {
  const normalized = modelRef.trim();
  if (normalized.length === 0) {
    throw new Error('Invalid agent model ref: expected a bare model id or "provider/id".');
  }
  if (normalized !== modelRef) {
    throw new Error(`Invalid agent model ref "${modelRef}": remove leading or trailing whitespace.`);
  }

  const slash = modelRef.indexOf("/");
  if (slash === -1) return { provider: "anthropic", id: modelRef };
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  if (provider.length === 0 || id.length === 0 || id.startsWith("/")) {
    throw new Error(`Invalid agent model ref "${modelRef}": expected "provider/id".`);
  }
  return { provider, id };
}
