import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isExistingPathError, isMissingPathError } from "./filesystem-error.ts";

/**
 * The per-install key that seals inline run scripts, in pi's agent directory. It lives outside every
 * project, so a repository can ship run records and scripts but never a seal this install accepts.
 */
export const WORKFLOW_RUN_SEAL_KEY_FILE = "workflow-run-seal.key";

const KEY_BYTES = 32;
const HEX_256 = /^[0-9a-f]{64}$/;

/** Whether `value` has a seal's shape; only {@link verifyWorkflowRunScriptSeal} says whether it is genuine. */
export function isWorkflowRunScriptSeal(value: unknown): value is string {
  return typeof value === "string" && HEX_256.test(value);
}

/** The seal a run record carries for its persisted inline script, creating this install's key on first use. */
export async function sealWorkflowRunScript(
  runId: string,
  sourceFingerprint: string,
  agentDir: string = getAgentDir(),
): Promise<string> {
  const path = join(agentDir, WORKFLOW_RUN_SEAL_KEY_FILE);
  return runSeal((await readSealKey(path)) ?? (await createSealKey(agentDir, path)), runId, sourceFingerprint);
}

/** Whether this install sealed `sourceFingerprint` for `runId`. Never creates a key: without one, nothing was sealed here. */
export async function verifyWorkflowRunScriptSeal(
  runId: string,
  sourceFingerprint: string,
  seal: string,
  agentDir: string = getAgentDir(),
): Promise<boolean> {
  if (!isWorkflowRunScriptSeal(seal)) return false;
  const key = await readSealKey(join(agentDir, WORKFLOW_RUN_SEAL_KEY_FILE));
  if (key === undefined) return false;
  return timingSafeEqual(Buffer.from(runSeal(key, runId, sourceFingerprint), "hex"), Buffer.from(seal, "hex"));
}

function runSeal(key: Buffer, runId: string, sourceFingerprint: string): string {
  return createHmac("sha256", key).update(`${runId}\0${sourceFingerprint}`).digest("hex");
}

async function readSealKey(path: string): Promise<Buffer | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
  const hex = content.trim();
  if (!HEX_256.test(hex)) {
    throw new Error(`workflow run seal key ${path} is malformed; delete it to create a new one, which retires every existing seal`);
  }
  return Buffer.from(hex, "hex");
}

/**
 * Publish a new key with an exclusive hard link from a complete temporary file, so a concurrent reader
 * never sees a partial key. When another process published one first, its key wins and is read back.
 */
async function createSealKey(agentDir: string, path: string): Promise<Buffer> {
  await mkdir(agentDir, { recursive: true });
  const key = randomBytes(KEY_BYTES);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${key.toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporaryPath, path);
    return key;
  } catch (error) {
    if (!isExistingPathError(error)) throw error;
    const existing = await readSealKey(path);
    if (existing === undefined) throw error;
    return existing;
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
