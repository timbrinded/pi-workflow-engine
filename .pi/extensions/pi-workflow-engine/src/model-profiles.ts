import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir, type ModelRegistry } from "@earendil-works/pi-coding-agent";
import { isMissingPathError } from "./filesystem-error.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export const WORKFLOW_MODEL_PROFILE_NAMES = ["small", "medium", "big"] as const;
export type WorkflowModelProfileName = (typeof WORKFLOW_MODEL_PROFILE_NAMES)[number];

export interface WorkflowModelProfileConfig {
  readonly model: string;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface WorkflowModelProfileFile {
  readonly profiles: Partial<Record<WorkflowModelProfileName, WorkflowModelProfileConfig>>;
}

export interface WorkflowModelProfilePaths {
  readonly user: string;
  readonly project: string;
}

interface ResolvedWorkflowModelProfileBase {
  readonly name: WorkflowModelProfileName;
  readonly model: Model<Api> | undefined;
  readonly thinkingLevel: ThinkingLevel | undefined;
}

export type ResolvedWorkflowModelProfile = ResolvedWorkflowModelProfileBase & (
  | { readonly source: "host" }
  | { readonly source: "project" | "user"; readonly configPath: string }
);

export type ResolvedWorkflowModelProfiles = Readonly<Record<WorkflowModelProfileName, ResolvedWorkflowModelProfile>>;

export interface WorkflowModelRouteRequest {
  readonly model?: string;
  readonly thinkingLevel?: ThinkingLevel;
  readonly profile?: WorkflowModelProfileName;
}

export class WorkflowModelProfileConfigError extends Error {
  override readonly name = "WorkflowModelProfileConfigError";
  readonly code = "WORKFLOW_MODEL_PROFILE_CONFIG";

  constructor(
    message: string,
    readonly configPath: string,
    readonly profile?: WorkflowModelProfileName,
  ) {
    super(message);
  }
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const HOST_FALLBACK_THINKING: Record<WorkflowModelProfileName, ThinkingLevel> = {
  small: "low",
  medium: "medium",
  big: "high",
};
const CONFIG_FILE_NAME = "workflow-models.json";

export function workflowModelProfilePaths(
  cwd: string,
  agentDir: string = getAgentDir(),
): WorkflowModelProfilePaths {
  return {
    user: join(agentDir, CONFIG_FILE_NAME),
    project: join(cwd, ".pi", CONFIG_FILE_NAME),
  };
}

export function resolveWorkflowModelProfiles(input: {
  readonly cwd: string;
  readonly modelRegistry: Pick<ModelRegistry, "find">;
  readonly hostModel: Model<Api> | undefined;
  readonly paths?: WorkflowModelProfilePaths;
}): ResolvedWorkflowModelProfiles {
  const paths = input.paths ?? workflowModelProfilePaths(input.cwd);
  const user = readWorkflowModelProfileFile(paths.user);
  const project = readWorkflowModelProfileFile(paths.project);
  const resolved = { ...hostWorkflowModelProfiles(input.hostModel) };

  for (const name of WORKFLOW_MODEL_PROFILE_NAMES) {
    const projectProfile = project.profiles[name];
    const configured = projectProfile ?? user.profiles[name];
    if (!configured) continue;

    const source = projectProfile ? "project" : "user";
    const configPath = paths[source];
    resolved[name] = {
      name,
      model: resolveConfiguredModel(name, configured.model, input.modelRegistry, configPath),
      thinkingLevel: configured.thinkingLevel,
      source,
      configPath,
    };
  }

  return resolved;
}

export function hostWorkflowModelProfiles(
  hostModel: Model<Api> | undefined,
): ResolvedWorkflowModelProfiles {
  return {
    small: { name: "small", model: hostModel, thinkingLevel: HOST_FALLBACK_THINKING.small, source: "host" },
    medium: { name: "medium", model: hostModel, thinkingLevel: HOST_FALLBACK_THINKING.medium, source: "host" },
    big: { name: "big", model: hostModel, thinkingLevel: HOST_FALLBACK_THINKING.big, source: "host" },
  };
}

export function resolveAgentModelProfile(
  input: {
    readonly request: WorkflowModelRouteRequest;
    readonly profiles: ResolvedWorkflowModelProfiles;
    readonly resolveExplicitModel: (modelRef: string) => Model<Api> | undefined;
    readonly hostModel: Model<Api> | undefined;
  },
): { readonly model: Model<Api> | undefined; readonly thinkingLevel: ThinkingLevel | undefined } {
  const profile = input.request.profile === undefined
    ? undefined
    : input.profiles[assertWorkflowModelProfileName(input.request.profile)];
  return {
    model: input.request.model === undefined
      ? (profile?.model ?? input.hostModel)
      : input.resolveExplicitModel(input.request.model),
    thinkingLevel: input.request.thinkingLevel ?? profile?.thinkingLevel,
  };
}

export function readWorkflowModelProfileFile(configPath: string): WorkflowModelProfileFile {
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return { profiles: {} };
    throw new WorkflowModelProfileConfigError(
      `Could not read workflow model profiles at ${configPath}: ${unknownErrorMessage(error)}. Fix the file permissions or remove the file.`,
      configPath,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new WorkflowModelProfileConfigError(
      `Invalid JSON in workflow model profiles at ${configPath}: ${unknownErrorMessage(error)}. Fix or remove the file.`,
      configPath,
    );
  }
  return parseWorkflowModelProfileFile(parsed, configPath);
}

export function setWorkflowModelProfile(input: {
  readonly configPath: string;
  readonly name: WorkflowModelProfileName;
  readonly profile: WorkflowModelProfileConfig;
  readonly modelRegistry: Pick<ModelRegistry, "find">;
}): void {
  const current = readWorkflowModelProfileFile(input.configPath);
  const next = { ...current.profiles, [input.name]: input.profile };
  for (const name of WORKFLOW_MODEL_PROFILE_NAMES) {
    const profile = next[name];
    if (profile) resolveConfiguredModel(name, profile.model, input.modelRegistry, input.configPath);
  }
  writeWorkflowModelProfileFile(input.configPath, { profiles: next });
}

export function clearWorkflowModelProfile(configPath: string, name: WorkflowModelProfileName): void {
  const current = readWorkflowModelProfileFile(configPath);
  if (!current.profiles[name]) return;
  const profiles = { ...current.profiles };
  delete profiles[name];
  writeWorkflowModelProfileFile(configPath, { profiles });
}

export function isWorkflowModelProfileName(value: string): value is WorkflowModelProfileName {
  return WORKFLOW_MODEL_PROFILE_NAMES.includes(value as WorkflowModelProfileName);
}

export function isWorkflowThinkingLevel(value: string): value is ThinkingLevel {
  return THINKING_LEVELS.has(value as ThinkingLevel);
}

function parseWorkflowModelProfileFile(value: unknown, configPath: string): WorkflowModelProfileFile {
  if (!isRecord(value)) throw invalidConfig(configPath, "the root must be an object");
  assertOnlyKeys(value, ["profiles"], configPath);
  if (!isRecord(value.profiles)) throw invalidConfig(configPath, '"profiles" must be an object');

  const profiles: Partial<Record<WorkflowModelProfileName, WorkflowModelProfileConfig>> = {};
  for (const [name, profile] of Object.entries(value.profiles)) {
    if (!isWorkflowModelProfileName(name)) {
      throw invalidConfig(configPath, `unknown profile "${name}"; expected small, medium, or big`);
    }
    if (!isRecord(profile)) throw invalidConfig(configPath, `profile "${name}" must be an object`, name);
    assertOnlyKeys(profile, ["model", "thinkingLevel"], configPath, name);
    if (typeof profile.model !== "string") {
      throw invalidConfig(configPath, `profile "${name}" requires a provider-qualified "model" string`, name);
    }
    assertThinkingLevel(profile.thinkingLevel, configPath, name);
    profiles[name] = {
      model: profile.model,
      ...(profile.thinkingLevel === undefined ? {} : { thinkingLevel: profile.thinkingLevel }),
    };
  }
  return { profiles };
}

function resolveConfiguredModel(
  name: WorkflowModelProfileName,
  modelRef: string,
  modelRegistry: Pick<ModelRegistry, "find">,
  configPath: string,
): Model<Api> {
  const slash = modelRef.indexOf("/");
  if (modelRef.trim() !== modelRef || slash <= 0 || slash === modelRef.length - 1) {
    throw invalidConfig(
      configPath,
      `profile "${name}" model must be an exact provider/model identity; received "${modelRef}"`,
      name,
    );
  }
  const provider = modelRef.slice(0, slash);
  const modelId = modelRef.slice(slash + 1);
  if (/\s/.test(provider) || modelId.startsWith("/") || modelId.endsWith("/") || /\s/.test(modelId)) {
    throw invalidConfig(
      configPath,
      `profile "${name}" model must be an exact provider/model identity; received "${modelRef}"`,
      name,
    );
  }
  const model = modelRegistry.find(provider, modelId);
  if (!model) {
    throw invalidConfig(
      configPath,
      `profile "${name}" references unavailable model "${modelRef}"; choose an exact model shown by /model and update it with /workflow:models set ${name} provider/model`,
      name,
    );
  }
  return model;
}

function assertWorkflowModelProfileName(value: string): WorkflowModelProfileName {
  if (isWorkflowModelProfileName(value)) return value;
  throw new Error(`Unknown workflow model profile "${value}"; expected small, medium, or big.`);
}

function assertThinkingLevel(
  value: unknown,
  configPath: string,
  profile: WorkflowModelProfileName,
): asserts value is ThinkingLevel | undefined {
  if (value === undefined || (typeof value === "string" && isWorkflowThinkingLevel(value))) return;
  throw invalidConfig(
    configPath,
    `profile "${profile}" thinkingLevel must be off, minimal, low, medium, high, xhigh, or max`,
    profile,
  );
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  configPath: string,
  profile?: WorkflowModelProfileName,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw invalidConfig(configPath, `unexpected key "${unexpected}"`, profile);
}

function writeWorkflowModelProfileFile(configPath: string, config: WorkflowModelProfileFile): void {
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Best effort: preserve the original write error.
    }
    throw new WorkflowModelProfileConfigError(
      `Could not write workflow model profiles at ${configPath}: ${unknownErrorMessage(error)}.`,
      configPath,
    );
  }
}

function invalidConfig(
  configPath: string,
  reason: string,
  profile?: WorkflowModelProfileName,
): WorkflowModelProfileConfigError {
  return new WorkflowModelProfileConfigError(
    `Invalid workflow model profile config at ${configPath}: ${reason}.`,
    configPath,
    profile,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
