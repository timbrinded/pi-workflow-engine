import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";
import workflowEngine from "../.pi/extensions/pi-workflow-engine/index.ts";
import {
  DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  DEFAULT_REVIEW_RESULTS_SHORTCUT,
  type DynamaxShortcuts,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";

export interface CapturedTool {
  readonly name: string;
  readonly promptGuidelines?: readonly string[];
  execute(
    toolCallId: string,
    params: { script?: string; name?: string; args?: string; resumeFromRunId?: string; resumeEditedWorkflow?: boolean; background?: boolean },
    signal: AbortSignal | undefined,
    onUpdate: () => void,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

export interface CapturedShortcut {
  readonly key: KeyId;
  readonly description?: string;
  handler(ctx: ExtensionContext): unknown | Promise<unknown>;
}

export interface CapturedCommand {
  readonly description?: string;
  handler(args: string, ctx: ExtensionCommandContext): unknown | Promise<unknown>;
}

export interface CapturedWorkflowExtension {
  readonly tool: CapturedTool;
  readonly shortcuts: readonly CapturedShortcut[];
  readonly commands: ReadonlyMap<string, CapturedCommand>;
  readonly sentMessages: readonly unknown[];
}

/** Register the full extension against a no-op pi host and expose its public surfaces. */
export function captureWorkflowExtension(
  shortcuts: DynamaxShortcuts = {
    inspector: DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
    results: DEFAULT_REVIEW_RESULTS_SHORTCUT,
  },
): CapturedWorkflowExtension {
  let capturedTool: CapturedTool | undefined;
  const capturedShortcuts: CapturedShortcut[] = [];
  const capturedCommands = new Map<string, CapturedCommand>();
  const sentMessages: unknown[] = [];
  const fakePi = {
    on: () => {},
    registerCommand: (name: string, command: CapturedCommand) => {
      capturedCommands.set(name, command);
    },
    registerShortcut: (key: KeyId, shortcut: Omit<CapturedShortcut, "key">) => {
      capturedShortcuts.push({ key, ...shortcut });
    },
    registerMessageRenderer: () => {},
    registerTool: (tool: unknown) => {
      const candidate = tool as CapturedTool;
      if (candidate.name === "workflow") capturedTool = candidate;
    },
    sendMessage: (message: unknown) => {
      sentMessages.push(message);
    },
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  workflowEngine(fakePi, shortcuts);
  if (!capturedTool) throw new Error("workflow tool was not registered");
  return { tool: capturedTool, shortcuts: capturedShortcuts, commands: capturedCommands, sentMessages };
}

export function captureWorkflowTool(): CapturedTool {
  return captureWorkflowExtension().tool;
}
