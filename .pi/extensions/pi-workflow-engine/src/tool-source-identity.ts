import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isMissingPathError } from "./filesystem-error.ts";
import { hashIdentity } from "./identity-fingerprint.ts";
import { logicalWorkspacePath, portableRelativePath } from "./replay-path-identity.ts";
import { captureTreeFingerprint, isPathWithin, validateTreeFile, type FingerprintCapture } from "./tree-fingerprint.ts";

export interface EffectiveToolSourceInfoLike {
  readonly path: string;
  readonly source: string;
  readonly scope: string;
  readonly origin: string;
  readonly baseDir?: string;
}

export interface EffectiveToolSourceIdentity {
  readonly path: string;
  readonly source: string;
  readonly scope: string;
  readonly origin: string;
  readonly baseDir?: string;
  readonly fingerprint: string;
}

export type ToolSourceFingerprintCache = Map<string, Promise<FingerprintCapture>>;

export interface ToolSourceIdentityOptions {
  readonly runtimeVersion: string;
  readonly sessionCwd: string;
  readonly workspaceRoot: string;
  readonly cache: ToolSourceFingerprintCache;
  readonly signal?: AbortSignal;
}

const SOURCE_FINGERPRINT_MAX_BYTES = 32 << 20;
const SOURCE_FINGERPRINT_MAX_FILES = 4096;
const SOURCE_FINGERPRINT_EXCLUSIONS = new Set([".git", ".pi/.workflow-runs"]);

export async function captureEffectiveToolSourceIdentity(
  sourceInfo: EffectiveToolSourceInfoLike,
  options: ToolSourceIdentityOptions,
): Promise<EffectiveToolSourceIdentity> {
  const path = nonEmptyString(sourceInfo.path, "tool source path");
  const source = nonEmptyString(sourceInfo.source, `source type for tool source "${path}"`);
  const scope = nonEmptyString(sourceInfo.scope, `scope for tool source "${path}"`);
  const origin = nonEmptyString(sourceInfo.origin, `origin for tool source "${path}"`);
  const declaredBaseDir = sourceInfo.baseDir === undefined ? undefined : nonEmptyString(sourceInfo.baseDir, `base directory for tool source "${path}"`);

  if (isSyntheticSource(path, source)) {
    const baseDir =
      declaredBaseDir === undefined
        ? undefined
        : normalizeUnresolvedBaseDir(declaredBaseDir, options.sessionCwd, options.workspaceRoot);
    const synthetic = { path, source, scope, origin, ...(baseDir === undefined ? {} : { baseDir }) };
    return {
      ...synthetic,
      fingerprint: hashIdentity({ runtimeVersion: options.runtimeVersion, source: synthetic }),
    };
  }

  const baseDir = declaredBaseDir === undefined ? undefined : resolveDeclaredPath(declaredBaseDir, options.sessionCwd);
  const sourcePath = await resolveExistingSourcePath(path, baseDir, options.sessionCwd, options.workspaceRoot);
  const sourceRoot = baseDir && isPathWithin(baseDir, sourcePath) ? baseDir : dirname(sourcePath);
  const validation = await validateTreeFile({
    root: sourceRoot,
    path: sourcePath,
    excludedRelativePaths: SOURCE_FINGERPRINT_EXCLUSIONS,
    signal: options.signal,
  });
  if (validation.kind === "unverifiable") throw new Error(`tool source "${path}" is not fingerprintable: ${validation.reason}`);

  let capture = options.cache.get(sourceRoot);
  if (!capture) {
    capture = captureTreeFingerprint({
      root: sourceRoot,
      excludedRelativePaths: SOURCE_FINGERPRINT_EXCLUSIONS,
      maxBytes: SOURCE_FINGERPRINT_MAX_BYTES,
      maxFiles: SOURCE_FINGERPRINT_MAX_FILES,
      signal: options.signal,
    });
    options.cache.set(sourceRoot, capture);
  }
  const fingerprint = await capture;
  if (fingerprint.kind === "unverifiable") throw new Error(`tool source "${path}" is not fingerprintable: ${fingerprint.reason}`);

  return {
    path: logicalSourcePath(sourcePath, sourceRoot, options.sessionCwd, options.workspaceRoot),
    source,
    scope,
    origin,
    ...(baseDir === undefined
      ? {}
      : { baseDir: logicalSourcePath(baseDir, sourceRoot, options.sessionCwd, options.workspaceRoot) }),
    fingerprint: fingerprint.fingerprint,
  };
}

async function resolveExistingSourcePath(
  path: string,
  baseDir: string | undefined,
  sessionCwd: string,
  workspaceRoot: string,
): Promise<string> {
  const candidates = isAbsolute(path)
    ? [resolve(path)]
    : uniquePaths([
        ...(baseDir ? [resolve(baseDir, path), resolve(baseDir, path.split(/[\\/]/).at(-1) ?? path)] : []),
        resolve(sessionCwd, path),
        resolve(workspaceRoot, path),
      ]);

  for (const candidate of candidates) {
    try {
      if ((await lstat(candidate)).isFile()) return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  throw new Error(`tool source path does not identify a regular file: ${path}`);
}

function resolveDeclaredPath(path: string, sessionCwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(sessionCwd, path);
}

function normalizeUnresolvedBaseDir(path: string, sessionCwd: string, workspaceRoot: string): string {
  const resolvedPath = resolveDeclaredPath(path, sessionCwd);
  return logicalWorkspacePath(resolvedPath, { sessionCwd, workspaceRoot }) ?? "source-root:.";
}

function logicalSourcePath(path: string, sourceRoot: string, sessionCwd: string, workspaceRoot: string): string {
  const workspacePath = logicalWorkspacePath(path, { sessionCwd, workspaceRoot });
  if (workspacePath) return workspacePath;
  if (isPathWithin(sourceRoot, path)) return `source-root:${portableRelativePath(sourceRoot, path)}`;
  throw new Error("tool source path is outside its fingerprint roots");
}

function isSyntheticSource(path: string, source: string): boolean {
  return (path.startsWith("<") && path.endsWith(">")) || source === "builtin" || source === "sdk" || /^(?:builtin|sdk):/.test(path);
}

function uniquePaths(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)];
}

function nonEmptyString(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  if (value.length === 0) throw new Error(`${label} is empty`);
  return value;
}
