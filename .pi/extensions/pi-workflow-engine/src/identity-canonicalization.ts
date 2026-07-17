export type IdentityCanonicalization =
  | { readonly kind: "verified"; readonly value: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface IdentityCanonicalizationOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

const DEFAULT_MAX_BYTES = 1 << 20;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 16_384;

/**
 * Produce a deterministic, bounded identity for JSON-like data.
 *
 * Replay inputs are not trusted: schemas and tool metadata can contain cycles,
 * accessors, proxies, or values JSON cannot represent. Those inputs disable
 * replay instead of throwing or being silently collapsed to the same key.
 */
export function canonicalizeIdentity(
  value: unknown,
  options: IdentityCanonicalizationOptions = {},
): IdentityCanonicalization {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const active = new WeakSet<object>();
  const chunks: string[] = [];
  let bytes = 0;
  let nodes = 0;

  const append = (chunk: string): void => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) throw new IdentityCanonicalizationError(`identity exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  };

  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new IdentityCanonicalizationError(`identity exceeded ${maxNodes} values`);
    if (depth > maxDepth) throw new IdentityCanonicalizationError(`identity exceeded ${maxDepth} levels`);

    if (current === null) {
      append("n;");
      return;
    }
    switch (typeof current) {
      case "undefined":
        append("u;");
        return;
      case "boolean":
        append(current ? "b1;" : "b0;");
        return;
      case "number":
        if (!Number.isFinite(current)) throw new IdentityCanonicalizationError("identity contains a non-finite number");
        append(`d${Object.is(current, -0) ? "-0" : String(current)};`);
        return;
      case "string":
        append(`s${Buffer.byteLength(current)}:${current};`);
        return;
      case "bigint":
      case "function":
      case "symbol":
        throw new IdentityCanonicalizationError(`identity contains unsupported ${typeof current} data`);
      case "object":
        break;
    }

    if (active.has(current)) throw new IdentityCanonicalizationError("identity contains a cycle");
    active.add(current);
    try {
      const prototype = Object.getPrototypeOf(current);
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype) throw new IdentityCanonicalizationError("identity contains an array with a custom prototype");
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const ownKeys = Reflect.ownKeys(current);
        if (ownKeys.some((key) => typeof key === "symbol")) {
          throw new IdentityCanonicalizationError("identity contains symbol keys");
        }
        if (ownKeys.some((key) => typeof key === "string" && key !== "length" && !isArrayIndex(key, current.length))) {
          throw new IdentityCanonicalizationError("identity array contains custom properties");
        }
        append(`a${current.length}[`);
        for (let index = 0; index < current.length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) {
            append("h;");
            continue;
          }
          if (!("value" in descriptor)) throw new IdentityCanonicalizationError("identity contains an array accessor");
          visit(descriptor.value, depth + 1);
        }
        append("];");
        return;
      }

      if (prototype !== Object.prototype && prototype !== null) {
        throw new IdentityCanonicalizationError("identity contains an object with a custom prototype");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const ownKeys = Reflect.ownKeys(current);
      if (ownKeys.some((key) => typeof key === "symbol")) {
        throw new IdentityCanonicalizationError("identity contains symbol keys");
      }
      const keys = Object.keys(descriptors).sort();
      append(`o${keys.length}{`);
      for (const key of keys) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor)) throw new IdentityCanonicalizationError(`identity property ${key} is an accessor`);
        append(`k${Buffer.byteLength(key)}:${key};`);
        append(`p${descriptor.enumerable ? 1 : 0}${descriptor.configurable ? 1 : 0}${descriptor.writable ? 1 : 0};`);
        visit(descriptor.value, depth + 1);
      }
      append("};");
    } finally {
      active.delete(current);
    }
  };

  try {
    visit(value, 0);
    return { kind: "verified", value: chunks.join("") };
  } catch (error) {
    return {
      kind: "unverifiable",
      reason: error instanceof IdentityCanonicalizationError ? error.message : "identity inspection failed",
    };
  }
}

class IdentityCanonicalizationError extends Error {}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
