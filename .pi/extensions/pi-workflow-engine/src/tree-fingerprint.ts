import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { throwIfAborted } from "./cancellation.ts";
import { isMissingPathError } from "./filesystem-error.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export type FingerprintCapture =
  | { readonly kind: "verified"; readonly fingerprint: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

export type TreeFileValidation =
  | { readonly kind: "verified" }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface TreeFingerprintOptions {
  readonly root: string;
  /** Root-relative directory paths to exclude, never bare names at every depth. */
  readonly excludedRelativePaths?: ReadonlySet<string>;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly signal?: AbortSignal;
}

export interface TreeFileValidationOptions {
  readonly root: string;
  readonly path: string;
  readonly excludedRelativePaths?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

export interface DeclaredInputFingerprintOptions {
  readonly root: string;
  /** Explicit paths relative to `root`. Files and directories are both supported. */
  readonly inputs: readonly string[];
  /** Paths with these segment sequences are never valid declared inputs. */
  readonly excludedRelativePaths?: ReadonlySet<string>;
  readonly maxBytes: number;
  readonly maxEntries: number;
  /** Record direct directory identity without recursively walking descendants. */
  readonly shallowDirectories?: boolean;
  readonly signal?: AbortSignal;
}

export type DeclaredInputPathResolution =
  | { readonly kind: "verified"; readonly paths: readonly string[] }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface FingerprintFileOperations {
  readonly open: (path: string, flags: number) => Promise<FileHandle>;
  readonly lstat: (path: string) => Promise<BigIntStats>;
}

const NODE_FINGERPRINT_FILE_OPERATIONS: FingerprintFileOperations = {
  open: async (path, flags) => await open(path, flags),
  lstat: async (path) => await lstat(path, { bigint: true }),
};

/** A deterministic hash sink that enforces one shared byte budget across file reads. */
export class BoundedFingerprint {
  readonly #hash = createHash("sha256");
  #bytes = 0;

  constructor(private readonly maxBytes: number) {}

  add(label: string, value: string | Buffer): void {
    this.#hash.update(label);
    this.#hash.update("\0");
    this.#hash.update(value);
    this.#hash.update("\0");
  }

  async addFileHandle(label: string, handle: FileHandle, signal?: AbortSignal): Promise<void> {
    this.#hash.update(label);
    this.#hash.update("\0");
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 << 10, signal });
    try {
      for await (const chunk of stream) {
        throwIfAborted(signal);
        const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        this.#bytes += buffer.length;
        if (this.#bytes > this.maxBytes) {
          stream.destroy();
          throw new Error(`content fingerprint exceeded ${this.maxBytes} bytes`);
        }
        this.#hash.update(buffer);
      }
    } catch (error) {
      throwIfAborted(signal);
      throw error;
    }
    this.#hash.update("\0");
  }

  digest(): string {
    return this.#hash.digest("hex");
  }
}

/** Open, validate, and use one regular file without reopening its pathname. */
export async function withValidatedFingerprintFile<T>(
  path: string,
  signal: AbortSignal | undefined,
  use: (handle: FileHandle, info: BigIntStats) => Promise<T>,
  operations: FingerprintFileOperations = NODE_FINGERPRINT_FILE_OPERATIONS,
): Promise<T> {
  throwIfAborted(signal);
  const flags = process.platform === "win32"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await operations.open(path, flags);
  try {
    const [openedInfo, pathInfo] = await Promise.all([
      handle.stat({ bigint: true }),
      operations.lstat(path),
    ]);
    throwIfAborted(signal);
    if (!openedInfo.isFile()) throw new Error(`content fingerprint opened an unsupported entry: ${path}`);
    if (pathInfo.isSymbolicLink()) throw new Error(`content fingerprint encountered a symbolic link: ${path}`);
    if (!pathInfo.isFile()) throw new Error(`content fingerprint encountered an unsupported entry: ${path}`);
    if (openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
      throw new Error(`content fingerprint path changed while it was being opened: ${path}`);
    }
    return await use(handle, openedInfo);
  } finally {
    await handle.close();
  }
}

/** Fingerprint a bounded directory tree with stable path ordering and entry handling. */
export async function captureTreeFingerprint(options: TreeFingerprintOptions): Promise<FingerprintCapture> {
  try {
    throwIfAborted(options.signal);
    const root = resolve(options.root);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) throw new Error(`fingerprint root is not a directory: ${root}`);

    const fingerprint = new BoundedFingerprint(options.maxBytes);
    const directories = [root];
    let fileCount = 0;

    for (let index = 0; index < directories.length; index++) {
      throwIfAborted(options.signal);
      const directory = directories[index]!;
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        throwIfAborted(options.signal);
        const path = join(directory, entry.name);
        const relativePath = relative(root, path);
        if (entry.isDirectory()) {
          if (!isExcludedRelativePath(relativePath, options.excludedRelativePaths)) directories.push(path);
          continue;
        }

        fileCount += 1;
        if (fileCount > options.maxFiles) throw new Error(`content fingerprint exceeded ${options.maxFiles} files`);
        fingerprint.add("path", relativePath);

        if (entry.isSymbolicLink()) {
          throw new Error(`content fingerprint encountered a symbolic link: ${path}`);
        }
        if (!entry.isFile()) throw new Error(`content fingerprint encountered an unsupported entry: ${path}`);

        await withValidatedFingerprintFile(path, options.signal, async (handle, info) => {
          fingerprint.add("mode", String(info.mode));
          await fingerprint.addFileHandle("file", handle, options.signal);
        });
      }
    }

    return { kind: "verified", fingerprint: fingerprint.digest() };
  } catch (error) {
    throwIfAborted(options.signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

/** Fingerprint only explicitly declared files/directories under one shared bound. */
export async function captureDeclaredInputFingerprint(
  options: DeclaredInputFingerprintOptions,
): Promise<FingerprintCapture> {
  try {
    throwIfAborted(options.signal);

    const root = resolve(options.root);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) throw new Error(`declared-input root is not a directory: ${root}`);

    const resolvedInputs = resolveDeclaredInputPaths(root, options.inputs, options.excludedRelativePaths);
    if (resolvedInputs.kind === "unverifiable") return resolvedInputs;
    const inputs = resolvedInputs.paths;
    const fingerprint = new BoundedFingerprint(options.maxBytes);
    let entryCount = 0;

    const recordEntry = (relativePath: string, kind: "directory" | "file" | "missing", mode?: number): void => {
      entryCount += 1;
      if (entryCount > options.maxEntries) {
        throw new Error(`declared-input fingerprint exceeded ${options.maxEntries} entries`);
      }
      fingerprint.add("path", relativePath);
      fingerprint.add("kind", kind);
      if (mode !== undefined) fingerprint.add("mode", String(mode));
    };

    const visit = async (path: string, relativePath: string, directInput = false): Promise<boolean> => {
      throwIfAborted(options.signal);

      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        recordEntry(relativePath, "missing");
        return true;
      }

      if (info.isSymbolicLink()) throw new Error(`declared input contains a symbolic link: ${relativePath}`);
      if (info.isFile()) {
        await withValidatedFingerprintFile(path, options.signal, async (handle, openedInfo) => {
          recordEntry(relativePath, "file", Number(openedInfo.mode));
          await fingerprint.addFileHandle("file", handle, options.signal);
        });
        return true;
      }
      if (!info.isDirectory()) throw new Error(`declared input contains an unsupported entry: ${relativePath}`);

      if (options.shallowDirectories === true) {
        recordEntry(relativePath, "directory", info.mode);
        return true;
      }

      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      let hasObservableChild = false;
      for (const entry of entries) {
        const childPath = join(path, entry.name);
        const childRelativePath = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
        if (isExcludedDeclaredInput(childRelativePath, options.excludedRelativePaths)) continue;
        hasObservableChild = (await visit(childPath, childRelativePath)) || hasObservableChild;
      }
      const observableEmptyDirectory = entries.length === 0 && !isExcludedAncestor(relativePath, options.excludedRelativePaths);
      if (!directInput && !hasObservableChild && !observableEmptyDirectory) return false;
      recordEntry(relativePath, "directory", info.mode);
      return true;
    };

    for (const relativePath of inputs) {
      throwIfAborted(options.signal);
      fingerprint.add("input", relativePath);
      const segments = relativePath === "." ? [] : relativePath.split("/");
      let path = root;
      let missing = false;
      for (let index = 0; index < Math.max(0, segments.length - 1); index++) {
        path = join(path, segments[index]!);
        let info;
        try {
          info = await lstat(path);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
          recordEntry(relativePath, "missing");
          missing = true;
          break;
        }
        if (info.isSymbolicLink()) throw new Error(`declared input traverses a symbolic link: ${relativePath}`);
        if (!info.isDirectory()) {
          recordEntry(relativePath, "missing");
          missing = true;
          break;
        }
      }
      if (!missing) await visit(relativePath === "." ? root : join(root, ...segments), relativePath, true);
    }

    return { kind: "verified", fingerprint: fingerprint.digest() };
  } catch (error) {
    throwIfAborted(options.signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

/** Validate and canonicalize caller-authored paths before passing them to Git or the filesystem. */
export function resolveDeclaredInputPaths(
  root: string,
  inputs: readonly string[],
  excludedRelativePaths?: ReadonlySet<string>,
  base = root,
): DeclaredInputPathResolution {
  try {
    if (!Array.isArray(inputs)) throw new Error("declared inputs must be an array");
    const paths = [...new Set(inputs.map((input) => declaredInputPath(root, base, input)))].sort();
    for (const path of paths) rejectExcludedDeclaredInput(path, excludedRelativePaths);
    return { kind: "verified", paths };
  } catch (error) {
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

/** Verify that a regular file is reached only through directories included in the tree hash. */
export async function validateTreeFile(options: TreeFileValidationOptions): Promise<TreeFileValidation> {
  try {
    throwIfAborted(options.signal);
    const root = resolve(options.root);
    const path = resolve(options.path);
    if (!isPathWithin(root, path)) return { kind: "unverifiable", reason: "file is outside its fingerprint root" };

    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) throw new Error(`fingerprint root is not a directory: ${root}`);
    const pathFromRoot = relative(root, path);
    if (pathFromRoot === "") return { kind: "unverifiable", reason: "fingerprint source resolves to its root directory" };

    const segments = pathFromRoot.split(/[\\/]/).filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index++) {
      throwIfAborted(options.signal);
      const segment = segments[index]!;
      const isFile = index === segments.length - 1;
      if (!isFile && isExcludedRelativePath(relative(root, join(current, segment)), options.excludedRelativePaths)) {
        return { kind: "unverifiable", reason: "file is inside an excluded fingerprint directory" };
      }
      current = join(current, segment);
      const info = await lstat(current);
      if (isFile ? !info.isFile() : !info.isDirectory()) {
        return {
          kind: "unverifiable",
          reason: isFile ? "fingerprint source is not a regular file" : "fingerprint source path traverses a non-directory entry",
        };
      }
    }
    return { kind: "verified" };
  } catch (error) {
    throwIfAborted(options.signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

export function isPathWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(path));
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

function isExcludedRelativePath(path: string, excluded: ReadonlySet<string> | undefined): boolean {
  if (!excluded || excluded.size === 0) return false;
  const normalized = normalizeRelativePath(path);
  for (const candidate of excluded) {
    const normalizedCandidate = normalizeRelativePath(candidate);
    if (normalized === normalizedCandidate || normalized.startsWith(`${normalizedCandidate}/`)) return true;
  }
  return false;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function declaredInputPath(root: string, base: string, input: string): string {
  if (typeof input !== "string" || input.length === 0) throw new Error("declared input paths must be non-empty strings");
  if (isAbsolute(input)) throw new Error(`declared input must be relative to the workflow cwd: ${input}`);
  const path = resolve(base, input);
  if (!isPathWithin(root, path)) throw new Error(`declared input escapes the repository root: ${input}`);
  if (!isPathWithin(base, path)) throw new Error(`declared input escapes the workflow cwd: ${input}`);
  const relativePath = relative(root, path).split(sep).join("/");
  return relativePath.length === 0 ? "." : relativePath;
}

function rejectExcludedDeclaredInput(path: string, excluded: ReadonlySet<string> | undefined): void {
  if (!isExcludedDeclaredInput(path, excluded)) return;
  throw new Error(`declared input enters excluded path: ${path}`);
}

function isExcludedDeclaredInput(path: string, excluded: ReadonlySet<string> | undefined): boolean {
  if (!excluded) return false;
  const normalized = normalizeRelativePath(path);
  for (const candidate of excluded) {
    const normalizedCandidate = normalizeRelativePath(candidate);
    if (
      normalized === normalizedCandidate ||
      normalized.startsWith(`${normalizedCandidate}/`) ||
      normalized.endsWith(`/${normalizedCandidate}`) ||
      normalized.includes(`/${normalizedCandidate}/`)
    ) {
      return true;
    }
  }
  return false;
}

function isExcludedAncestor(path: string, excluded: ReadonlySet<string> | undefined): boolean {
  if (!excluded) return false;
  const segments = normalizeRelativePath(path).split("/").filter((segment) => segment !== ".");
  for (const candidate of excluded) {
    const normalizedCandidate = normalizeRelativePath(candidate);
    for (let index = 0; index < segments.length; index++) {
      const suffix = segments.slice(index).join("/");
      if (normalizedCandidate.startsWith(`${suffix}/`)) return true;
    }
  }
  return false;
}
