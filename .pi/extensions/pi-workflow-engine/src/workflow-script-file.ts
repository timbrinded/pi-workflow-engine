import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { compileInlineWorkflow } from "./inline-workflow.ts";
import { isPathWithin } from "./tree-fingerprint.ts";
import type { LoadedWorkflow } from "./types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/** A `scriptPath` that resolves outside the workflow cwd or cannot be read. */
export class WorkflowScriptPathError extends Error {
  override readonly name = "WorkflowScriptPathError";
}

/**
 * Read an inline-format script named relative to `cwd`. Both paths are resolved through symlinks first,
 * so a link inside the cwd cannot reach a file outside it.
 */
export async function readWorkflowScriptFile(cwd: string, scriptPath: string): Promise<string> {
  let root: string;
  let file: string;
  try {
    root = await realpath(cwd);
    file = await realpath(resolve(cwd, scriptPath));
  } catch (error) {
    throw new WorkflowScriptPathError(`scriptPath ${scriptPath} could not be resolved: ${unknownErrorMessage(error)}`);
  }
  if (!isPathWithin(root, file)) throw new WorkflowScriptPathError(`scriptPath ${scriptPath} resolves outside the working directory`);
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new WorkflowScriptPathError(`scriptPath ${scriptPath} could not be read: ${unknownErrorMessage(error)}`);
  }
}

/** Compile a script file exactly like an inline `script`: same contract, injected `Type`, content fingerprint. */
export async function compileWorkflowScriptFile(cwd: string, scriptPath: string): Promise<LoadedWorkflow> {
  return compileInlineWorkflow(await readWorkflowScriptFile(cwd, scriptPath));
}
