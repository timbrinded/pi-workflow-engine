/** Cap text at `limit` characters, ending a cut value with an ellipsis. */
export function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
