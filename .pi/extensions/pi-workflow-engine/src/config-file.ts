import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isMissingPathError } from "./filesystem-error.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/** A JSON config that lives once per user and once per project, the project file overriding the user one. */
export interface ConfigFilePaths {
  readonly user: string;
  readonly project: string;
}

export function configFilePaths(fileName: string, cwd: string, agentDir: string = getAgentDir()): ConfigFilePaths {
  return {
    user: join(agentDir, fileName),
    project: join(cwd, ".pi", fileName),
  };
}

/** The parsed JSON at `configPath`, or undefined when there is no file. `label` names the config in errors. */
export function readJsonConfigFile(configPath: string, label: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw new Error(`Could not read ${label} at ${configPath}: ${unknownErrorMessage(error)}. Fix the file permissions or remove the file.`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${configPath}: ${unknownErrorMessage(error)}. Fix or remove the file.`);
  }
}

/** Replace `configPath` atomically, so a concurrent reader sees the old file or the new one. */
export function writeJsonConfigFile(configPath: string, value: unknown, label: string): void {
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: preserve the original write error.
    }
    throw new Error(`Could not write ${label} at ${configPath}: ${unknownErrorMessage(error)}.`);
  }
}
