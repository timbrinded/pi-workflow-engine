/** A non-null, non-array object whose fields can be inspected by name. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A full SHA-1 or SHA-256 Git object ID. */
export function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}
