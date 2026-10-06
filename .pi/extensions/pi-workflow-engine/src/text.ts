/** Cap text at `limit` characters, ending a cut value with an ellipsis. */
export function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Pretty-printed JSON, or undefined when the value has no JSON form or cannot be serialized (cycles, BigInt). */
export function prettyJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

/** Compact count for display: 999, 1.2k, 12.3k, 123k, 1.2M. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  if (value < 1_000) return `${Math.trunc(n)}`;
  if (value < 1_000_000) return `${sign}${formatCompact(value / 1_000)}k`;
  return `${sign}${formatCompact(value / 1_000_000)}M`;
}

function formatCompact(value: number): string {
  if (value >= 100) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}
