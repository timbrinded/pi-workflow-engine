import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import {
  clearWorkflowModelProfile,
  isWorkflowModelProfileName,
  isWorkflowThinkingLevel,
  resolveWorkflowModelProfiles,
  setWorkflowModelProfile,
  workflowModelProfilePaths,
  WORKFLOW_MODEL_PROFILE_NAMES,
  type ResolvedWorkflowModelProfiles,
  type WorkflowModelProfilePaths,
  type WorkflowModelProfileName,
} from "./model-profiles.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";

type ConfigScope = "user" | "project";

type WorkflowModelsCommand =
  | { readonly kind: "status" }
  | {
      readonly kind: "set";
      readonly scope: ConfigScope;
      readonly profile: WorkflowModelProfileName;
      readonly model: string;
      readonly thinkingLevel?: Parameters<typeof setWorkflowModelProfile>[0]["profile"]["thinkingLevel"];
    }
  | { readonly kind: "clear"; readonly scope: ConfigScope; readonly profile: WorkflowModelProfileName }
  | { readonly kind: "error"; readonly message: string };

const USAGE =
  "Usage: /workflow:models [status | set <small|medium|big> <provider/model> [thinkingLevel] [--user|--project] | clear <small|medium|big> [--user|--project]]";
const MODEL_COMMAND_ACTIONS = [
  { value: "status", description: "Show resolved workflow model profiles" },
  { value: "set", description: "Configure an exact model for a profile" },
  { value: "clear", description: "Remove a configured profile" },
] as const;
const MODEL_COMMAND_SCOPES = [
  { value: "--user", description: "Write the user-level workflow model config" },
  { value: "--project", description: "Write the project-level workflow model config" },
] as const;
const MODEL_COMMAND_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function registerWorkflowModelProfileCommand(pi: ExtensionAPI): void {
  pi.registerCommand("workflow:models", {
    description: "Inspect or configure exact small, medium, and big workflow model profiles",
    getArgumentCompletions: workflowModelProfileArgumentCompletions,
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const command = parseWorkflowModelsCommand(args);
      if (command.kind === "error") {
        ctx.ui.notify(`${command.message}\n${USAGE}`, "warning");
        return;
      }

      try {
        const paths = workflowModelProfilePaths(ctx.cwd);
        if (command.kind === "set") {
          setWorkflowModelProfile({
            configPath: paths[command.scope],
            name: command.profile,
            profile: {
              model: command.model,
              ...(command.thinkingLevel === undefined ? {} : { thinkingLevel: command.thinkingLevel }),
            },
            modelRegistry: ctx.modelRegistry,
          });
        } else if (command.kind === "clear") {
          clearWorkflowModelProfile(paths[command.scope], command.profile);
        }

        const profiles = resolveWorkflowModelProfiles({
          cwd: ctx.cwd,
          modelRegistry: ctx.modelRegistry,
          hostModel: ctx.model,
          paths,
        });
        const prefix = command.kind === "status"
          ? "Workflow model profiles"
          : `${command.profile} ${command.kind === "set" ? "updated" : "cleared"} in ${command.scope} config`;
        ctx.ui.notify(`${prefix}\n${formatWorkflowModelProfiles(profiles, paths)}`, "info");
      } catch (error) {
        ctx.ui.notify(unknownErrorMessage(error), "error");
      }
    },
  });
}

export function workflowModelProfileArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const parts = splitArgumentPrefix(argumentPrefix);
  const completedWithoutScopes = parts.completed.filter((token) => token !== "--user" && token !== "--project");
  const action = completedWithoutScopes[0];
  const scopes = parts.completed.some((token) => token === "--user" || token === "--project")
    ? []
    : MODEL_COMMAND_SCOPES;

  if (completedWithoutScopes.length === 0) {
    return completeCurrentArgument(argumentPrefix, MODEL_COMMAND_ACTIONS);
  }
  if (action === "status") return null;
  if (completedWithoutScopes.length === 1) {
    return completeCurrentArgument(
      argumentPrefix,
      WORKFLOW_MODEL_PROFILE_NAMES.map((value) => ({ value, description: `${value} workflow model profile` })),
    );
  }
  if (action === "clear") return completeCurrentArgument(argumentPrefix, scopes);
  if (action !== "set") return null;

  if (completedWithoutScopes.length === 2) {
    return null;
  }
  if (completedWithoutScopes.length === 3) {
    return completeCurrentArgument(argumentPrefix, [
      ...MODEL_COMMAND_THINKING_LEVELS.map((value) => ({ value, description: "Thinking level" })),
      ...scopes,
    ]);
  }
  return completeCurrentArgument(argumentPrefix, scopes);
}

export function parseWorkflowModelsCommand(args: string): WorkflowModelsCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === "status")) return { kind: "status" };

  const userScope = tokens.includes("--user");
  const projectScope = tokens.includes("--project");
  if (userScope && projectScope) return { kind: "error", message: "Choose either --user or --project, not both." };
  const scope: ConfigScope = projectScope ? "project" : "user";
  const positional = tokens.filter((token) => token !== "--user" && token !== "--project");
  const [action, profile, model, thinkingLevel, ...extra] = positional;
  if (extra.length > 0) return { kind: "error", message: "Too many /workflow:models arguments." };
  if (!profile || !isWorkflowModelProfileName(profile)) {
    return { kind: "error", message: "Profile must be small, medium, or big." };
  }

  if (action === "clear") {
    if (model !== undefined) return { kind: "error", message: "The clear action accepts only a profile and optional scope." };
    return { kind: "clear", scope, profile };
  }
  if (action !== "set") return { kind: "error", message: `Unknown /workflow:models action "${action ?? ""}".` };
  if (!model) return { kind: "error", message: "The set action requires an exact provider/model identity." };
  if (thinkingLevel !== undefined && !isWorkflowThinkingLevel(thinkingLevel)) {
    return { kind: "error", message: "Thinking level must be off, minimal, low, medium, high, xhigh, or max." };
  }
  return {
    kind: "set",
    scope,
    profile,
    model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

function formatWorkflowModelProfiles(
  profiles: ResolvedWorkflowModelProfiles,
  paths: WorkflowModelProfilePaths,
): string {
  const lines = WORKFLOW_MODEL_PROFILE_NAMES.map((name) => {
    const profile = profiles[name];
    const model = profile.model ? `${profile.model.provider}/${profile.model.id}` : "(no host model)";
    const thinking = profile.thinkingLevel ?? "host";
    const source = profile.source === "host" ? "host fallback" : `${profile.source}: ${profile.configPath}`;
    return `${name}: ${model} · thinking ${thinking} · ${source}`;
  });
  return [...lines, `user: ${paths.user}`, `project: ${paths.project} (overrides user)`].join("\n");
}
