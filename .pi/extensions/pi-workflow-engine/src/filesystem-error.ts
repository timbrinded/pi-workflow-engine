/** Identify a missing filesystem path reported by Node's filesystem APIs. */
export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
