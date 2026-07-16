import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { throwIfAborted } from "./cancellation.ts";

export type FingerprintCapture =
  | { readonly kind: "verified"; readonly fingerprint: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

export type TreeFileValidation =
  | { readonly kind: "verified" }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface TreeFingerprintOptions {
  readonly root: string;
  readonly excludedDirectoryNames?: ReadonlySet<string>;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly signal?: AbortSignal;
}

export interface TreeFileValidationOptions {
  readonly root: string;
  readonly path: string;
  readonly excludedDirectoryNames?: ReadonlySet<string>;
  readonly signal?: AbortSignal;
}

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

  async addFile(label: string, path: string, signal?: AbortSignal): Promise<void> {
    this.#hash.update(label);
    this.#hash.update("\0");
    const stream = createReadStream(path, { highWaterMark: 64 << 10, signal });
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
          if (!options.excludedDirectoryNames?.has(entry.name)) directories.push(path);
          continue;
        }

        fileCount += 1;
        if (fileCount > options.maxFiles) throw new Error(`content fingerprint exceeded ${options.maxFiles} files`);
        fingerprint.add("path", relativePath);

        if (entry.isSymbolicLink()) {
          fingerprint.add("symlink", await readlink(path));
          continue;
        }
        if (!entry.isFile()) throw new Error(`content fingerprint encountered an unsupported entry: ${path}`);

        const info = await lstat(path);
        fingerprint.add("mode", String(info.mode));
        await fingerprint.addFile("file", path, options.signal);
      }
    }

    return { kind: "verified", fingerprint: fingerprint.digest() };
  } catch (error) {
    throwIfAborted(options.signal);
    return { kind: "unverifiable", reason: errorMessage(error) };
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

    const segments = relative(root, path).split(/[\\/]/).filter(Boolean);
    let current = root;
    for (let index = 0; index < segments.length; index++) {
      throwIfAborted(options.signal);
      const segment = segments[index]!;
      const isFile = index === segments.length - 1;
      if (!isFile && options.excludedDirectoryNames?.has(segment)) {
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
    return { kind: "unverifiable", reason: errorMessage(error) };
  }
}

export function isPathWithin(root: string, path: string): boolean {
  const pathFromRoot = relative(resolve(root), resolve(path));
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !pathFromRoot.startsWith("/"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
