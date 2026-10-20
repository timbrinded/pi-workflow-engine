import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";
import { configFilePaths, readJsonConfigFile, writeJsonConfigFile, type ConfigFilePaths } from "./config-file.ts";
import { isRecord } from "./guards.ts";
import { DEFAULT_WORKFLOW_MAX_AGENTS } from "./options.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/**
 * How large the host should make each workflow it authors. A prompt guideline only: the run's
 * `maxAgents` limit stays the separate hard cap.
 */
export const WORKFLOW_SIZE_GUIDELINES = ["small", "medium", "large", "off"] as const;
export type WorkflowSizeGuideline = (typeof WORKFLOW_SIZE_GUIDELINES)[number];
export const DEFAULT_WORKFLOW_SIZE_GUIDELINE: WorkflowSizeGuideline = "medium";

const SIZE_AGENT_LIMITS: Readonly<Record<Exclude<WorkflowSizeGuideline, "off">, number>> = { small: 5, medium: 10, large: 25 };
const SETTINGS_FILE_NAME = "workflow-settings.json";
const SETTINGS_LABEL = "workflow settings";

export interface WorkflowSettingsFile {
  readonly size?: WorkflowSizeGuideline;
}

export type ResolvedWorkflowSize =
  | { readonly size: WorkflowSizeGuideline; readonly source: "default" }
  | { readonly size: WorkflowSizeGuideline; readonly source: "user" | "project"; readonly configPath: string };

export function workflowSettingsPaths(cwd: string, agentDir?: string): ConfigFilePaths {
  return configFilePaths(SETTINGS_FILE_NAME, cwd, agentDir);
}

export function isWorkflowSizeGuideline(value: string): value is WorkflowSizeGuideline {
  return WORKFLOW_SIZE_GUIDELINES.includes(value as WorkflowSizeGuideline);
}

export function readWorkflowSettingsFile(configPath: string): WorkflowSettingsFile {
  const parsed = readJsonConfigFile(configPath, SETTINGS_LABEL);
  if (parsed === undefined) return {};
  if (!isRecord(parsed)) throw invalidSettings(configPath, "the root must be an object");
  const unexpected = Object.keys(parsed).find((key) => key !== "size");
  if (unexpected) throw invalidSettings(configPath, `unexpected key "${unexpected}"`);
  const { size } = parsed;
  if (size === undefined) return {};
  if (typeof size !== "string" || !isWorkflowSizeGuideline(size)) {
    throw invalidSettings(configPath, '"size" must be small, medium, large, or off');
  }
  return { size };
}

/** The project file wins over the user file, which wins over the default. */
export function resolveWorkflowSize(paths: ConfigFilePaths): ResolvedWorkflowSize {
  for (const source of ["project", "user"] as const) {
    const { size } = readWorkflowSettingsFile(paths[source]);
    if (size !== undefined) return { size, source, configPath: paths[source] };
  }
  return { size: DEFAULT_WORKFLOW_SIZE_GUIDELINE, source: "default" };
}

export function setWorkflowSize(configPath: string, size: WorkflowSizeGuideline): void {
  const current = readWorkflowSettingsFile(configPath);
  writeJsonConfigFile(configPath, { ...current, size }, SETTINGS_LABEL);
}

/** The catalog line for a size, or undefined when the guideline is off. */
export function workflowSizeGuidelineLine(size: WorkflowSizeGuideline): string | undefined {
  if (size === "off") return undefined;
  return `Workflow size guideline: ${size} — keep each workflow under ${SIZE_AGENT_LIMITS[size]} agents unless the user asks for more; the user changes this with /workflow:size.`;
}

type WorkflowSizeCommand =
  | { readonly kind: "status" }
  | { readonly kind: "set"; readonly size: WorkflowSizeGuideline; readonly scope: keyof ConfigFilePaths }
  | { readonly kind: "error"; readonly message: string };

const USAGE = "Usage: /workflow:size [small|medium|large|off] [--user|--project]";
const SIZE_COMPLETIONS = WORKFLOW_SIZE_GUIDELINES.map((value) => ({
  value,
  description: value === "off" ? "No size guideline in the prompt" : `Keep each workflow under ${SIZE_AGENT_LIMITS[value]} agents`,
}));
const SCOPE_COMPLETIONS = [
  { value: "--user", description: "Write the user-level workflow settings" },
  { value: "--project", description: "Write the project-level workflow settings" },
] as const;

export function parseWorkflowSizeCommand(args: string): WorkflowSizeCommand {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const userScope = tokens.includes("--user");
  const projectScope = tokens.includes("--project");
  if (userScope && projectScope) return { kind: "error", message: "Choose either --user or --project, not both." };
  const positional = tokens.filter((token) => token !== "--user" && token !== "--project");
  if (positional.length === 0) {
    return userScope || projectScope ? { kind: "error", message: "Name a size to write." } : { kind: "status" };
  }
  const [size, ...extra] = positional;
  if (extra.length > 0 || !size || !isWorkflowSizeGuideline(size)) {
    return { kind: "error", message: "Size must be small, medium, large, or off." };
  }
  return { kind: "set", size, scope: projectScope ? "project" : "user" };
}

export function workflowSizeArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const { completed } = splitArgumentPrefix(argumentPrefix);
  if (completed.length === 0) return completeCurrentArgument(argumentPrefix, SIZE_COMPLETIONS);
  if (completed.length === 1 && isWorkflowSizeGuideline(completed[0] ?? "")) return completeCurrentArgument(argumentPrefix, SCOPE_COMPLETIONS);
  return null;
}

export function formatWorkflowSize(resolved: ResolvedWorkflowSize): string {
  const source = resolved.source === "default" ? "default" : `${resolved.source} config ${resolved.configPath}`;
  const rule = resolved.size === "off"
    ? "no size guideline is added to the prompt"
    : `keep each workflow under ${SIZE_AGENT_LIMITS[resolved.size]} agents unless the user asks for more`;
  return [
    `Workflow size guideline: ${resolved.size} (${source}) — ${rule}.`,
    `The maxAgents run limit (default ${DEFAULT_WORKFLOW_MAX_AGENTS}) stays the hard cap on live agents per run.`,
  ].join("\n");
}

/** Register `/workflow:size`; `onChange` lets the session's prompt pick the new guideline up. */
export function registerWorkflowSizeCommand(pi: Pick<ExtensionAPI, "registerCommand">, onChange: (ctx: ExtensionCommandContext) => void): void {
  pi.registerCommand("workflow:size", {
    description: "Show or set the workflow size guideline: /workflow:size [small|medium|large|off] [--user|--project]",
    getArgumentCompletions: workflowSizeArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseWorkflowSizeCommand(args);
      if (command.kind === "error") {
        ctx.ui.notify(`${command.message}\n${USAGE}`, "warning");
        return;
      }
      try {
        const paths = workflowSettingsPaths(ctx.cwd);
        if (command.kind === "set") {
          setWorkflowSize(paths[command.scope], command.size);
          onChange(ctx);
        }
        ctx.ui.notify(formatWorkflowSize(resolveWorkflowSize(paths)), "info");
      } catch (error) {
        ctx.ui.notify(unknownErrorMessage(error), "error");
      }
    },
  });
}

function invalidSettings(configPath: string, reason: string): Error {
  return new Error(`Invalid workflow settings at ${configPath}: ${reason}. Fix or remove the file.`);
}
