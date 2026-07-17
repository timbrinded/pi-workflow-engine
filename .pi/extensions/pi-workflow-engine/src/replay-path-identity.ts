import { relative, resolve, sep } from "node:path";
import { isPathWithin } from "./tree-fingerprint.ts";

export interface ReplayWorkspaceRoots {
  readonly sessionCwd: string;
  readonly workspaceRoot: string;
}

/** Map a path in either the disposable session or main workspace to one stable namespace. */
export function logicalWorkspacePath(path: string, roots: ReplayWorkspaceRoots): string | undefined {
  for (const root of resolvedWorkspaceRoots(roots)) {
    if (isPathWithin(root, path)) return `workspace:${portableRelativePath(root, path)}`;
  }
  return undefined;
}

/** Normalize absolute workspace paths embedded in generated system prompts. */
export function normalizeWorkspaceReferences(value: string, roots: ReplayWorkspaceRoots): string {
  const paths = [...resolvedWorkspaceRoots(roots)].sort((left, right) => right.length - left.length);
  return paths.reduce((normalized, path) => replacePathPrefix(normalized, path, "<workspace>"), value);
}

export function portableRelativePath(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

function resolvedWorkspaceRoots(roots: ReplayWorkspaceRoots): readonly string[] {
  return [...new Set([resolve(roots.sessionCwd), resolve(roots.workspaceRoot)])];
}

function replacePathPrefix(value: string, prefix: string, replacement: string): string {
  let result = "";
  let cursor = 0;
  while (cursor < value.length) {
    const index = value.indexOf(prefix, cursor);
    if (index === -1) return result + value.slice(cursor);
    const next = value[index + prefix.length];
    if (next !== undefined && next !== "/" && next !== "\\" && /[\p{L}\p{N}._-]/u.test(next)) {
      result += value.slice(cursor, index + prefix.length);
      cursor = index + prefix.length;
      continue;
    }
    result += value.slice(cursor, index) + replacement;
    cursor = index + prefix.length;
  }
  return result;
}
