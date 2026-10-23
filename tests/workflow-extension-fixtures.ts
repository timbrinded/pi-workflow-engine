import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, KeyId } from "@earendil-works/pi-tui";
import workflowEngine from "../.pi/extensions/pi-workflow-engine/index.ts";
import { isRecord } from "../.pi/extensions/pi-workflow-engine/src/guards.ts";
import {
  DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  DEFAULT_REVIEW_RESULTS_SHORTCUT,
  type DynamaxShortcuts,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";

export interface CapturedTool {
  readonly name: string;
  readonly exposure?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: { readonly properties: Readonly<Record<string, unknown>> };
  readonly reachesTools?: (input: Record<string, unknown>) => "all" | readonly string[];
  execute(
    toolCallId: string,
    params: {
      script?: string;
      scriptPath?: string;
      name?: string;
      args?: unknown;
      resumeFromRunId?: string;
      resumeEditedWorkflow?: boolean;
      background?: boolean;
    },
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
  getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler(args: string, ctx: ExtensionCommandContext): unknown | Promise<unknown>;
}

export type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown;

/** The slice of `before_agent_start` options the extension reads and writes. */
export interface CapturedPromptOptions {
  readonly selectedTools: string[];
  readonly sections: Record<string, string>;
  forceSystemPrompt?: string;
}

export interface CapturedWorkflowExtension {
  readonly tool: CapturedTool;
  readonly shortcuts: readonly CapturedShortcut[];
  readonly commands: ReadonlyMap<string, CapturedCommand>;
  readonly handlers: ReadonlyMap<string, readonly CapturedHandler[]>;
  readonly sentMessages: readonly unknown[];
  /** The options of each `sendMessage` call, index-aligned with `sentMessages`. */
  readonly sentMessageOptions: readonly unknown[];
  readonly sentUserMessages: readonly unknown[];
  /** Run every `before_agent_start` handler in order, chaining a returned prompt the way pi does. */
  beforeAgentStart(
    options: CapturedPromptOptions,
    ctx: ExtensionContext,
    messageType?: "user" | "custom",
  ): Promise<CapturedPromptOptions>;
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
  const sentMessageOptions: unknown[] = [];
  const sentUserMessages: unknown[] = [];
  const handlers = new Map<string, CapturedHandler[]>();
  const fakePi = {
    on: (event: string, handler: CapturedHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
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
    sendMessage: (message: unknown, options?: unknown) => {
      sentMessages.push(message);
      sentMessageOptions.push(options);
    },
    sendUserMessage: (content: unknown) => {
      sentUserMessages.push(content);
    },
  } as unknown as ExtensionAPI;
  workflowEngine(fakePi, shortcuts);
  if (!capturedTool) throw new Error("workflow tool was not registered");
  async function beforeAgentStart(
    options: CapturedPromptOptions,
    ctx: ExtensionContext,
    messageType: "user" | "custom" = "user",
  ): Promise<CapturedPromptOptions> {
    for (const handler of handlers.get("before_agent_start") ?? []) {
      const result: unknown = await handler({ type: "before_agent_start", messageType, systemPrompt: "", systemPromptOptions: options }, ctx);
      if (isRecord(result) && typeof result.systemPrompt === "string") options.forceSystemPrompt = result.systemPrompt;
    }
    return options;
  }
  return {
    tool: capturedTool,
    shortcuts: capturedShortcuts,
    commands: capturedCommands,
    handlers,
    sentMessages,
    sentMessageOptions,
    sentUserMessages,
    beforeAgentStart,
  };
}

export function captureWorkflowTool(): CapturedTool {
  return captureWorkflowExtension().tool;
}
