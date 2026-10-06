import { repoPathCandidates } from "../advisory-evidence.ts";
import type { AdvisoryLocation } from "../advisory-schema.ts";

const C_QUOTE_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-style quoting of unusual path names, e.g. `"b/caf\303\251.txt"`. */
function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  const bytes: number[] = [];
  for (const [, escape, literal] of path.slice(1, -1).matchAll(/\\([0-7]{3}|.)|([^\\]+)/g)) {
    if (literal !== undefined) bytes.push(...Buffer.from(literal));
    else if (escape !== undefined) bytes.push(escape.length === 3 ? parseInt(escape, 8) : (C_QUOTE_ESCAPES[escape] ?? escape.charCodeAt(0)));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Parse a unified diff into the set of added/changed new-file line numbers per file. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let file: string | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = unquoteGitPath(raw.slice(4).trim());
      file = path === "/dev/null" ? null : path.replace(/^b\//, "");
      if (file && !byFile.has(file)) byFile.set(file, new Set());
    } else if (raw.startsWith("@@")) {
      const match = /\+(\d+)/.exec(raw);
      newLine = match ? Number(match[1]) : 0;
    } else if (file === null || raw.startsWith("---") || raw.startsWith("\\")) {
      // file header, deletion, or "No newline" marker — record nothing
    } else if (raw.startsWith("+")) {
      byFile.get(file)!.add(newLine++);
    } else if (!raw.startsWith("-")) {
      newLine++; // context line advances the new-file counter; deletions do not
    }
  }
  return byFile;
}

/**
 * The location re-keyed to its repo-relative diff path when it is inside the diff, else undefined.
 * The exact path wins; a stray `./`, `a/` or `b/` prefix is tolerated. File-level locations count
 * if the file changed; lines get ±1 of fuzz.
 */
export function diffAnchor(changed: ReadonlyMap<string, ReadonlySet<number>>, location: AdvisoryLocation): AdvisoryLocation | undefined {
  for (const file of repoPathCandidates(location.file)) {
    const lines = changed.get(file);
    if (!lines) continue;
    const { line } = location;
    return line == null || lines.has(line) || lines.has(line - 1) || lines.has(line + 1) ? { ...location, file } : undefined;
  }
  return undefined;
}
