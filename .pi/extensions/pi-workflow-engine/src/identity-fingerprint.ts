import { createHash } from "node:crypto";
import { canonicalizeIdentity } from "./identity-canonicalization.ts";

export function hashIdentity(value: unknown): string {
  const canonical = canonicalizeIdentity(value);
  if (canonical.kind === "unverifiable") throw new Error(canonical.reason);
  return `sha256:${createHash("sha256").update(canonical.value).digest("hex")}`;
}

export function inspectableFunctionSource(value: unknown, label: string): string {
  if (typeof value !== "function") throw new Error(`${label} is not a function`);
  const source = Function.prototype.toString.call(value);
  if (source.length === 0 || source.includes("[native code]")) throw new Error(`${label} has no inspectable source`);
  return source;
}
