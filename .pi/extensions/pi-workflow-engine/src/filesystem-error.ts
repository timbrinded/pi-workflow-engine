/** Identify a missing filesystem path reported by Node's filesystem APIs. */
export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Identify a path that already exists, as reported for an exclusive (`wx`) create. */
export function isExistingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
