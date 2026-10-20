import type { Stats } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { compileInlineWorkflow } from "./inline-workflow.ts";
import type { LoadedWorkflow } from "./types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/** The largest script file a `scriptPath` may name; real workflow scripts are a few kilobytes. */
export const MAX_WORKFLOW_SCRIPT_FILE_BYTES = 1 << 20;

/** A `scriptPath` that cannot be read. */
export class WorkflowScriptPathError extends Error {
  override readonly name = "WorkflowScriptPathError";
}

/**
 * Read an inline-format script named relative to `cwd`. No containment: the script runs with the
 * extension's access either way, as an inline `script` does.
 */
export async function readWorkflowScriptFile(cwd: string, scriptPath: string): Promise<string> {
  return await readBoundedScriptFile(resolve(cwd, scriptPath), `scriptPath ${scriptPath}`);
}

/**
 * Read a workflow script only if it is a regular file within the size limit: a FIFO or device would
 * block the read or never end. `label` names the file in errors.
 */
export async function readBoundedScriptFile(file: string, label: string): Promise<string> {
  const unreadable = (error: unknown) => new WorkflowScriptPathError(`${label} could not be read: ${unknownErrorMessage(error)}`);
  let info: Stats;
  try {
    info = await stat(file);
  } catch (error) {
    throw unreadable(error);
  }
  if (!info.isFile()) throw new WorkflowScriptPathError(`${label} is not a regular file`);
  if (info.size > MAX_WORKFLOW_SCRIPT_FILE_BYTES) {
    throw new WorkflowScriptPathError(`${label} is ${info.size} bytes, over the ${MAX_WORKFLOW_SCRIPT_FILE_BYTES}-byte limit`);
  }
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw unreadable(error);
  }
}

/** Compile a script file exactly like an inline `script`: same contract, injected `Type`, content fingerprint. */
export async function compileWorkflowScriptFile(cwd: string, scriptPath: string): Promise<LoadedWorkflow> {
  return compileInlineWorkflow(await readWorkflowScriptFile(cwd, scriptPath));
}
