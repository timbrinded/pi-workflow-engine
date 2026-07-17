/** Read an unknown thrown value without allowing hostile coercion to mask the original failure. */
export function unknownErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unknown error";
  }
}
