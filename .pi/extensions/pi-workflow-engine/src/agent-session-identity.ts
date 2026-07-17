import { resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { throwIfAborted } from "./cancellation.ts";
import { hashIdentity, inspectableFunctionSource } from "./identity-fingerprint.ts";
import { normalizeWorkspaceReferences } from "./replay-path-identity.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import {
  captureEffectiveToolSourceIdentity,
  type EffectiveToolSourceIdentity,
  type EffectiveToolSourceInfoLike,
  type ToolSourceFingerprintCache,
} from "./tool-source-identity.ts";
export type { EffectiveToolSourceIdentity, EffectiveToolSourceInfoLike } from "./tool-source-identity.ts";

export interface EffectiveAgentModelLike {
  readonly provider: string;
  readonly id: string;
}

export interface EffectiveToolInfoLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptGuidelines?: readonly string[];
  readonly sourceInfo: EffectiveToolSourceInfoLike;
}

/** Only execution-relevant fields are required; installed pi ToolDefinition values satisfy this shape. */
export interface EffectiveToolDefinitionLike {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly executionMode?: string;
  readonly prepareArguments?: unknown;
  readonly execute: unknown;
}

/** Structural subset of AgentSession so lightweight fakes can verify replay identity behavior. */
export interface EffectiveAgentSessionLike {
  readonly systemPrompt: string;
  readonly model: EffectiveAgentModelLike | undefined;
  readonly thinkingLevel: string;
  getActiveToolNames(): readonly string[];
  getAllTools(): readonly EffectiveToolInfoLike[];
  getToolDefinition(name: string): EffectiveToolDefinitionLike | undefined;
}

export interface EffectiveToolIdentity {
  readonly name: string;
  readonly definitionFingerprint: string;
  readonly implementationFingerprint: string;
  readonly source: EffectiveToolSourceIdentity;
}

export interface EffectiveAgentSessionIdentity {
  readonly fingerprint: string;
  readonly runtimeVersion: string;
  readonly systemPromptFingerprint: string;
  readonly model: EffectiveAgentModelLike;
  readonly thinkingLevel: string;
  /** Ordered exactly as the effective AgentSession reports its active tools. */
  readonly tools: readonly EffectiveToolIdentity[];
}

export type EffectiveAgentSessionIdentityCapture =
  | { readonly kind: "verified"; readonly identity: EffectiveAgentSessionIdentity }
  | { readonly kind: "unverifiable"; readonly reason: string };

export interface EffectiveAgentSessionIdentityOptions {
  /** Stable main-workspace root used as the logical path namespace across replay attempts. */
  readonly workspaceRoot: string;
  /** Effective cwd used to create the session, which may be a randomized disposable worktree. */
  readonly sessionCwd: string;
  /** Override only for tests or a host embedding a version-compatible coding-agent runtime. */
  readonly runtimeVersion?: string;
  readonly signal?: AbortSignal;
}

interface IdentityComponents {
  readonly runtimeVersion: string;
  readonly systemPromptFingerprint: string;
  readonly model: EffectiveAgentModelLike;
  readonly thinkingLevel: string;
  readonly tools: readonly EffectiveToolIdentity[];
}

/**
 * Capture the post-creation AgentSession state that determines whether a cached
 * agent result is safe to replay. Any missing or opaque executable identity
 * fails closed instead of producing a partial key.
 */
export async function captureEffectiveAgentSessionIdentity(
  session: EffectiveAgentSessionLike,
  options: EffectiveAgentSessionIdentityOptions,
): Promise<EffectiveAgentSessionIdentityCapture> {
  try {
    throwIfAborted(options.signal);
    const workspaceRoot = resolve(nonEmptyString(options.workspaceRoot, "workspace root"));
    const sessionCwd = resolve(nonEmptyString(options.sessionCwd, "session cwd"));
    const runtimeVersion = nonEmptyString(options.runtimeVersion ?? VERSION, "coding-agent runtime version");
    const systemPrompt = stringValue(session.systemPrompt, "effective system prompt");
    const thinkingLevel = nonEmptyString(session.thinkingLevel, "effective thinking level");
    const model = captureModel(session.model);
    const activeToolNames = captureActiveToolNames(session.getActiveToolNames());
    const toolInfoByName = indexToolInfo(session.getAllTools());
    const sourceCaptures: ToolSourceFingerprintCache = new Map();
    const tools: EffectiveToolIdentity[] = [];

    for (const name of activeToolNames) {
      throwIfAborted(options.signal);
      const info = toolInfoByName.get(name);
      if (!info) throw new Error(`active tool "${name}" is absent from the tool registry`);
      const definition = session.getToolDefinition(name);
      if (!definition) throw new Error(`active tool "${name}" has no executable definition`);
      tools.push(
        await captureToolIdentity(name, info, definition, {
          runtimeVersion,
          signal: options.signal,
          sessionCwd,
          sourceCaptures,
          workspaceRoot,
        }),
      );
    }

    const components: IdentityComponents = {
      runtimeVersion,
      systemPromptFingerprint: hashIdentity(
        normalizeWorkspaceReferences(systemPrompt, { sessionCwd, workspaceRoot }),
      ),
      model,
      thinkingLevel,
      tools,
    };
    return {
      kind: "verified",
      identity: {
        fingerprint: hashIdentity(components),
        ...components,
      },
    };
  } catch (error) {
    throwIfAborted(options.signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

interface ToolCaptureOptions {
  readonly runtimeVersion: string;
  readonly sessionCwd: string;
  readonly workspaceRoot: string;
  readonly sourceCaptures: ToolSourceFingerprintCache;
  readonly signal?: AbortSignal;
}

async function captureToolIdentity(
  name: string,
  info: EffectiveToolInfoLike,
  definition: EffectiveToolDefinitionLike,
  options: ToolCaptureOptions,
): Promise<EffectiveToolIdentity> {
  if (nonEmptyString(info.name, `registry name for active tool "${name}"`) !== name) {
    throw new Error(`tool registry returned a mismatched definition for "${name}"`);
  }
  if (nonEmptyString(definition.name, `definition name for active tool "${name}"`) !== name) {
    throw new Error(`tool definition returned a mismatched definition for "${name}"`);
  }

  const registryGuidelines = stringArray(info.promptGuidelines ?? [], `prompt guidelines for active tool "${name}"`);
  const definitionGuidelines = stringArray(definition.promptGuidelines ?? [], `definition prompt guidelines for active tool "${name}"`);
  const executeSource = inspectableFunctionSource(definition.execute, `execute handler for active tool "${name}"`);
  const prepareArgumentsSource =
    definition.prepareArguments === undefined
      ? null
      : inspectableFunctionSource(definition.prepareArguments, `argument-preparation handler for active tool "${name}"`);
  const source = await captureEffectiveToolSourceIdentity(info.sourceInfo, {
    runtimeVersion: options.runtimeVersion,
    sessionCwd: options.sessionCwd,
    workspaceRoot: options.workspaceRoot,
    cache: options.sourceCaptures,
    signal: options.signal,
  });

  return {
    name,
    definitionFingerprint: hashIdentity({
      registry: {
        description: stringValue(info.description, `description for active tool "${name}"`),
        parameters: info.parameters,
        promptGuidelines: registryGuidelines,
      },
      definition: {
        description: stringValue(definition.description, `definition description for active tool "${name}"`),
        parameters: definition.parameters,
        promptSnippet: optionalString(definition.promptSnippet, `prompt snippet for active tool "${name}"`),
        promptGuidelines: definitionGuidelines,
        executionMode: optionalString(definition.executionMode, `execution mode for active tool "${name}"`),
      },
    }),
    implementationFingerprint: hashIdentity({ executeSource, prepareArgumentsSource }),
    source,
  };
}

function captureModel(model: EffectiveAgentModelLike | undefined): EffectiveAgentModelLike {
  if (!model) throw new Error("effective model is unavailable");
  return {
    provider: nonEmptyString(model.provider, "effective model provider"),
    id: nonEmptyString(model.id, "effective model id"),
  };
}

function captureActiveToolNames(names: readonly string[]): readonly string[] {
  if (!Array.isArray(names)) throw new Error("active tool names are unavailable");
  const seen = new Set<string>();
  return names.map((value, index) => {
    const name = nonEmptyString(value, `active tool name at index ${index}`);
    if (seen.has(name)) throw new Error(`active tool list contains duplicate "${name}" entries`);
    seen.add(name);
    return name;
  });
}

function indexToolInfo(tools: readonly EffectiveToolInfoLike[]): ReadonlyMap<string, EffectiveToolInfoLike> {
  if (!Array.isArray(tools)) throw new Error("tool registry is unavailable");
  const indexed = new Map<string, EffectiveToolInfoLike>();
  for (const [index, tool] of tools.entries()) {
    const name = nonEmptyString(tool.name, `tool registry name at index ${index}`);
    if (indexed.has(name)) throw new Error(`tool registry contains duplicate "${name}" entries`);
    indexed.set(name, tool);
  }
  return indexed;
}

function stringArray(value: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${label} must be a string array`);
  return [...value];
}

function optionalString(value: string | undefined, label: string): string | null {
  if (value === undefined) return null;
  return stringValue(value, label);
}

function nonEmptyString(value: string, label: string): string {
  const result = stringValue(value, label);
  if (result.length === 0) throw new Error(`${label} is empty`);
  return result;
}

function stringValue(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}
