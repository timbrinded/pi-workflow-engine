import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, KeyId } from "@earendil-works/pi-tui";
import { completeCurrentArgument } from "./command-completions.ts";
import { resolveDynamaxShortcuts, type DynamaxShortcuts } from "./dynamax-shortcuts.ts";
import { sessionKey } from "./session-identity.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface DynamaxState {
  sticky: boolean;
  oneShotPending: boolean;
  turnActive: boolean;
}

export interface DynamaxRuntime {
  state: DynamaxState;
  runningWorkflow?: string;
}

export type DynamaxRuntimeStore = Map<string, DynamaxRuntime>;
export type DynamaxEffect = "shine" | "static" | "off";

export interface DynamaxAnimationScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface DynamaxRegistrationOptions {
  openInspector?: (ctx: ExtensionContext) => Promise<void> | void;
  getEffect?: () => DynamaxEffect;
  animationScheduler?: DynamaxAnimationScheduler;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;
export const DYNAMAX_STATUS_KEY = "dynamax";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface DynamaxEditorInstallation {
  factory: EditorFactory;
  previousFactory: EditorFactory | undefined;
  decorations: Set<DynamaxEditorDecoration>;
}

const DYNAMAX_RENDER_PATTERN = /(^|[^A-Za-z0-9_])(dynamax)(?=[^A-Za-z0-9_]|$)/gi;
const DYNAMAX_COLORS = [
  [233, 137, 115],
  [228, 186, 103],
  [141, 192, 122],
  [102, 194, 179],
  [121, 157, 207],
  [157, 134, 195],
  [206, 130, 172],
] as const;
const RESET_FOREGROUND = "\x1b[39m";
export const DYNAMAX_EFFECT_ENV = "PI_DYNAMAX_EFFECT";
export const DYNAMAX_ANIMATION_FRAME_MS = 135;
const DYNAMAX_SHINE_FRAME_COUNT = DYNAMAX_COLORS.length;
const DEFAULT_DYNAMAX_ANIMATION_SCHEDULER: DynamaxAnimationScheduler = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const DYNAMAX_ACTION_COMPLETIONS = [
  { value: "on", description: "Keep Dynamax enabled for this session" },
  { value: "off", description: "Disable sticky and pending Dynamax modes" },
  { value: "status", description: "Show the current Dynamax state" },
] as const;

export function resolveDynamaxEffect(env: NodeJS.ProcessEnv = process.env): DynamaxEffect {
  const configured = env[DYNAMAX_EFFECT_ENV]?.trim().toLowerCase();
  if (configured === "shine" || configured === "static" || configured === "off") return configured;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "off";
  return "shine";
}

export function highlightDynamaxTokens(line: string, shinePosition?: number): string {
  const { visibleText, rawPositions } = mapVisibleCharacters(line);
  const insertions = new Map<number, string>();
  for (const match of visibleText.matchAll(DYNAMAX_RENDER_PATTERN)) {
    const token = match[2]!;
    const visibleStart = match.index! + match[1]!.length;
    for (let index = 0; index < token.length; index++) {
      const rawPosition = rawPositions[visibleStart + index]!;
      const color = DYNAMAX_COLORS[index % DYNAMAX_COLORS.length]!;
      const shine = shinePosition === undefined ? (index === 0 ? 0.45 : 0) : shineFactor(index, shinePosition);
      insertions.set(rawPosition, foregroundColor(color, shine));
    }
    const restorePosition = rawPositions[visibleStart + token.length] ?? line.length;
    insertions.set(restorePosition, activeForegroundAt(line, restorePosition));
  }
  if (insertions.size === 0) return line;

  let highlighted = "";
  for (let rawPosition = 0; rawPosition <= line.length; rawPosition++) {
    highlighted += insertions.get(rawPosition) ?? "";
    if (rawPosition < line.length) highlighted += line[rawPosition];
  }
  return highlighted;
}

function shineFactor(index: number, shinePosition: number): number {
  const distance = Math.abs(index - shinePosition);
  if (distance === 0) return 0.7;
  if (distance === 1) return 0.3;
  return 0;
}

function foregroundColor(color: readonly [number, number, number], shine: number): string {
  const red = Math.round(color[0] + (255 - color[0]) * shine);
  const green = Math.round(color[1] + (255 - color[1]) * shine);
  const blue = Math.round(color[2] + (255 - color[2]) * shine);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function mapVisibleCharacters(line: string): { visibleText: string; rawPositions: number[] } {
  let visibleText = "";
  const rawPositions: number[] = [];
  let rawPosition = 0;
  while (rawPosition < line.length) {
    const controlLength = terminalControlSequenceLength(line, rawPosition);
    if (controlLength > 0) {
      rawPosition += controlLength;
      continue;
    }
    visibleText += line[rawPosition];
    rawPositions.push(rawPosition);
    rawPosition += 1;
  }
  return { visibleText, rawPositions };
}

function terminalControlSequenceLength(line: string, position: number): number {
  if (line[position] !== "\x1b") return 0;
  const introducer = line[position + 1];
  if (introducer === "[") {
    for (let index = position + 2; index < line.length; index++) {
      const code = line.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index - position + 1;
    }
    return line.length - position;
  }
  if (introducer === "]" || introducer === "_") {
    for (let index = position + 2; index < line.length; index++) {
      if (line[index] === "\x07") return index - position + 1;
      if (line[index] === "\x1b" && line[index + 1] === "\\") return index - position + 2;
    }
    return line.length - position;
  }
  return Math.min(2, line.length - position);
}

function activeForegroundAt(line: string, endPosition: number): string {
  let foreground = RESET_FOREGROUND;
  let position = 0;
  while (position < endPosition) {
    const controlLength = terminalControlSequenceLength(line, position);
    if (controlLength === 0) {
      position += 1;
      continue;
    }
    const sequence = line.slice(position, position + controlLength);
    if (sequence.startsWith("\x1b[") && sequence.endsWith("m")) {
      foreground = foregroundAfterSgr(foreground, sequence);
    }
    position += controlLength;
  }
  return foreground;
}

function foregroundAfterSgr(current: string, sequence: string): string {
  const rawParameters = sequence.slice(2, -1);
  const parameters = rawParameters === "" ? ["0"] : rawParameters.split(";");
  let foreground = current;
  for (let index = 0; index < parameters.length; index++) {
    const rawParameter = parameters[index]!;
    const parameter = sgrParameter(rawParameter);
    if (parameter === 0 || parameter === 39) {
      foreground = RESET_FOREGROUND;
      continue;
    }
    if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
      foreground = `\x1b[${parameter}m`;
      continue;
    }
    if (parameter !== 38 && parameter !== 48 && parameter !== 58) continue;

    const extended = parseExtendedSgrColor(parameters, index);
    index = extended.lastIndex;
    if (parameter === 38 && extended.color) foreground = extended.color;
  }
  return foreground;
}

function parseExtendedSgrColor(parameters: string[], index: number): { color?: string; lastIndex: number } {
  const inline = parameters[index]!.split(":");
  if (inline.length > 1) {
    const mode = sgrParameter(inline[1] ?? "");
    if (mode === 5) {
      const paletteIndex = validColorChannel(inline[2]);
      return { color: paletteIndex === undefined ? undefined : `\x1b[38;5;${paletteIndex}m`, lastIndex: index };
    }
    if (mode === 2) {
      const channels = inline.length >= 6 ? inline.slice(-3) : inline.slice(2, 5);
      const rgb = validRgbChannels(channels);
      return { color: rgb ? `\x1b[38;2;${rgb.join(";")}m` : undefined, lastIndex: index };
    }
    return { lastIndex: index };
  }

  const mode = sgrParameter(parameters[index + 1] ?? "");
  if (mode === 5) {
    const paletteIndex = validColorChannel(parameters[index + 2]);
    return {
      color: paletteIndex === undefined ? undefined : `\x1b[38;5;${paletteIndex}m`,
      lastIndex: Math.min(parameters.length - 1, index + 2),
    };
  }
  if (mode === 2) {
    const rgb = validRgbChannels(parameters.slice(index + 2, index + 5));
    return {
      color: rgb ? `\x1b[38;2;${rgb.join(";")}m` : undefined,
      lastIndex: Math.min(parameters.length - 1, index + 4),
    };
  }
  return { lastIndex: Math.min(parameters.length - 1, index + 1) };
}

function validRgbChannels(channels: string[]): [number, number, number] | undefined {
  if (channels.length !== 3) return undefined;
  const parsed = channels.map(validColorChannel);
  if (parsed.some((channel) => channel === undefined)) return undefined;
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

function validColorChannel(channel: string | undefined): number | undefined {
  if (channel === undefined || !/^\d{1,3}$/.test(channel)) return undefined;
  const parsed = Number(channel);
  return parsed <= 255 ? parsed : undefined;
}

function sgrParameter(parameter: string): number {
  const primary = parameter.split(":", 1)[0];
  if (primary === "") return 0;
  const parsed = Number(primary);
  return Number.isFinite(parsed) ? parsed : -1;
}

export interface DynamaxEditorDecoration {
  readonly editor: EditorComponent;
  dispose(): void;
}

export interface DynamaxEditorDecorationOptions {
  getEffect?: () => DynamaxEffect;
  scheduler?: DynamaxAnimationScheduler;
  isActive?: () => boolean;
}

export function decorateDynamaxEditor(
  editor: EditorComponent,
  requestRender: () => void,
  options: DynamaxEditorDecorationOptions = {},
): DynamaxEditorDecoration {
  const originalRender = editor.render;
  const scheduler = options.scheduler ?? DEFAULT_DYNAMAX_ANIMATION_SCHEDULER;
  const getEffect = options.getEffect ?? resolveDynamaxEffect;
  const isActive = options.isActive ?? (() => true);
  let disposed = false;
  let cancelScheduled: (() => void) | undefined;
  let lastSignature: string | undefined;
  let lastEffect: DynamaxEffect | undefined;
  let animationStartedAt: number | undefined;

  const cancelAnimation = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
    animationStartedAt = undefined;
  };
  const scheduleRender = (delayMs: number): void => {
    if (cancelScheduled || disposed || !isActive()) return;
    cancelScheduled = scheduler.schedule(() => {
      cancelScheduled = undefined;
      if (disposed || !isActive()) return;
      requestRender();
    }, Math.max(0, delayMs));
  };

  const decoratedRender = (width: number): string[] => {
    const lines = originalRender.call(editor, width);
    const effect = getEffect();
    const signature = visibleDynamaxSignature(lines);
    if (signature !== lastSignature || effect !== lastEffect) {
      cancelAnimation();
      lastSignature = signature;
      lastEffect = effect;
      if (signature && effect === "shine" && isActive()) animationStartedAt = scheduler.now();
    }

    let shinePosition: number | undefined;
    if (animationStartedAt !== undefined && signature && effect === "shine" && isActive()) {
      const now = scheduler.now();
      const elapsed = Math.max(0, now - animationStartedAt);
      const frame = Math.floor(elapsed / DYNAMAX_ANIMATION_FRAME_MS);
      if (frame < DYNAMAX_SHINE_FRAME_COUNT) {
        shinePosition = frame;
        const nextFrameAt = animationStartedAt + (frame + 1) * DYNAMAX_ANIMATION_FRAME_MS;
        scheduleRender(nextFrameAt - now);
      } else {
        cancelAnimation();
      }
    } else if (!signature || effect !== "shine" || !isActive()) {
      cancelAnimation();
    }

    if (effect === "off") return lines;
    return lines.map((line) => highlightDynamaxTokens(line, shinePosition));
  };

  editor.render = decoratedRender;
  return {
    editor,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimation();
      if (editor.render === decoratedRender) editor.render = originalRender;
    },
  };
}

function visibleDynamaxSignature(lines: string[]): string {
  const matches: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const { visibleText } = mapVisibleCharacters(lines[lineIndex]!);
    for (const match of visibleText.matchAll(DYNAMAX_RENDER_PATTERN)) {
      const visibleStart = match.index! + match[1]!.length;
      matches.push(`${lineIndex}:${visibleStart}:${match[2]!}`);
    }
  }
  return matches.join("|");
}

export const ADAPTIVE_WORKFLOW_GUIDANCE = `
Adaptive multi-pass workflows are optional. Use a simple single-pass fan-out when it is sufficient. When the first pass may expose gaps, conflicts, weak claims, or missing evidence:
- run the bounded first-pass agents;
- give their surviving results to a structured gap-analysis agent so the LLM decides what needs follow-up;
- put a hard maxItems bound on LLM-authored task arrays and defensively slice them before fan-out;
- use ordinary TypeScript conditionals or bounded loops to launch follow-up agents only when gaps exist;
- synthesize the first-pass and follow-up results together.
Do not generate a second pass when the first pass is sufficient, and do not invent iteration, quorum, graph, reduction, or retry primitives for this pattern.`;

export const DYNAMAX_REMINDER = `
## dynamax workflow opt-in

The user has opted into dynamax multi-agent orchestration. The workflow tool is permitted for this task. You may either run an existing named workflow or author a new inline workflow script when that best serves the user's request.

Inline workflow rules:
- Use the injected Type object for schemas, for example Type.Object({ ok: Type.Boolean() }); do not import typebox.
- Do not use import statements or dynamic import() in inline workflow scripts.
- Set profile to "small", "medium", or "big" on each agent() call so routing remains explicit; use model/thinkingLevel only for an intentional override.
- Subagents receive no skills by default. Add \`skills: ["skill-name"]\` per agent only when that stage should load that skill; grant the smallest useful set.
- Provide exactly one of workflow.name or workflow.script.

${ADAPTIVE_WORKFLOW_GUIDANCE}
`;

const DYNAMAX_CONTEXT_CUSTOM_TYPE = "workflow-dynamax-reminder";

export function createDynamaxState(): DynamaxState {
  return { sticky: false, oneShotPending: false, turnActive: false };
}

export function createDynamaxRuntime(): DynamaxRuntime {
  return { state: createDynamaxState() };
}

export function getDynamaxRuntime(store: DynamaxRuntimeStore, ctx: Pick<ExtensionContext, "sessionManager">): DynamaxRuntime {
  const key = sessionKey(ctx);
  const existing = store.get(key);
  if (existing) return existing;
  const runtime = createDynamaxRuntime();
  store.set(key, runtime);
  return runtime;
}

export function hasDynamaxToken(text: string): boolean {
  return DYNAMAX_TOKEN_PATTERN.test(text);
}

export function markDynamaxOneShot(state: DynamaxState): void {
  state.oneShotPending = true;
}

export function enableDynamaxSticky(state: DynamaxState): void {
  state.sticky = true;
}

export function clearDynamax(state: DynamaxState): void {
  state.sticky = false;
  state.oneShotPending = false;
  state.turnActive = false;
}

export function isDynamaxActive(state: DynamaxState): boolean {
  return state.sticky || state.oneShotPending || state.turnActive;
}

export function describeDynamaxState(state: DynamaxState): string {
  const sticky = state.sticky ? "on" : "off";
  const oneShot = state.oneShotPending ? "pending" : "clear";
  const turn = state.turnActive ? "; active for current turn" : "";
  return `sticky ${sticky}; one-shot ${oneShot}${turn}`;
}

export function dynamaxWidgetLine(state: DynamaxState, shortcut: KeyId | null, runningWorkflow?: string): string {
  const modes = [
    runningWorkflow ? `running ${runningWorkflow}` : undefined,
    state.sticky ? "sticky on" : undefined,
    !state.sticky && state.turnActive ? "active this turn" : undefined,
    state.oneShotPending ? "one-shot pending" : undefined,
  ].filter((value): value is string => value !== undefined);
  const mode = modes.join(" + ") || "off";
  const inspectorHint = shortcut ? `${shortcut} inspector` : "/workflow:inspector";
  return `dynamax: ${mode} | /workflow:dynamax on|off | ${inspectorHint}`;
}

export function appendDynamaxSystemReminder(systemPrompt: string, state: DynamaxState): string {
  if (!state.sticky && !state.oneShotPending) return systemPrompt;
  state.oneShotPending = false;
  state.turnActive = true;
  return `${systemPrompt}\n\n${DYNAMAX_REMINDER.trim()}`;
}

export function appendDynamaxContextReminder(messages: AgentMessage[], state: DynamaxState): AgentMessage[] {
  if (!state.sticky) return messages;
  return [...messages, createDynamaxContextMessage()];
}

export function registerDynamax(
  pi: ExtensionAPI,
  shortcuts: DynamaxShortcuts = resolveDynamaxShortcuts(),
  options: DynamaxRegistrationOptions = {},
): void {
  const runtimes: DynamaxRuntimeStore = new Map();
  let editorInstallation: DynamaxEditorInstallation | undefined;
  const openInspector =
    options.openInspector ??
    ((ctx: ExtensionContext): void => {
      ctx.ui.notify("No workflow inspector is available yet", "warning");
    });
  const installEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const previousFactory = ctx.ui.getEditorComponent();
    if (editorInstallation && editorInstallation.factory === previousFactory) return;

    const decorations = new Set<DynamaxEditorDecoration>();
    const installation: DynamaxEditorInstallation = {
      previousFactory,
      decorations,
      factory: (tui, theme, keybindings) => {
        const decorate = (editor: EditorComponent): EditorComponent => {
          const decoration = decorateDynamaxEditor(editor, () => tui.requestRender(), {
            getEffect: options.getEffect,
            scheduler: options.animationScheduler,
            isActive: () => editorInstallation === installation && ctx.ui.getEditorComponent() === installation.factory,
          });
          decorations.add(decoration);
          return decoration.editor;
        };
        if (!previousFactory) return decorate(new CustomEditor(tui, theme, keybindings));

        try {
          return decorate(previousFactory(tui, theme, keybindings));
        } catch (error) {
          ctx.ui.notify(
            `Dynamax could not compose the existing custom editor (${unknownErrorMessage(error)}); using pi's stock-compatible CustomEditor so highlighting stays enabled`,
            "warning",
          );
          installation.previousFactory = undefined;
          return decorate(new CustomEditor(tui, theme, keybindings));
        }
      },
    };

    try {
      ctx.ui.setEditorComponent(installation.factory);
    } catch (error) {
      for (const decoration of decorations) decoration.dispose();
      decorations.clear();
      ctx.ui.notify(`Dynamax highlighting could not be installed: ${unknownErrorMessage(error)}`, "error");
      throw error;
    }
    editorInstallation = installation;
  };
  const uninstallEditor = (ctx: ExtensionContext): void => {
    const installation = editorInstallation;
    if (!installation) return;
    editorInstallation = undefined;
    for (const decoration of installation.decorations) decoration.dispose();
    installation.decorations.clear();
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === installation.factory) {
      ctx.ui.setEditorComponent(installation.previousFactory);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    installEditor(ctx);
    updateDynamaxSurfaces(ctx, getDynamaxRuntime(runtimes, ctx), shortcuts);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    uninstallEditor(ctx);
    clearDynamaxSurfaces(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (hasDynamaxToken(event.text)) {
      markDynamaxOneShot(runtime.state);
      updateDynamaxSurfaces(ctx, runtime, shortcuts);
    }
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    const systemPrompt = appendDynamaxSystemReminder(event.systemPrompt, runtime.state);
    if (systemPrompt === event.systemPrompt) return undefined;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return { systemPrompt };
  });

  pi.on("agent_end", (_event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    runtime.runningWorkflow = undefined;
    if (!runtime.state.sticky) runtime.state.turnActive = false;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    if (event.toolName !== "workflow") return undefined;
    const runtime = getDynamaxRuntime(runtimes, ctx);
    runtime.runningWorkflow = workflowLabel(event.args);
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return undefined;
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (event.toolName !== "workflow") return undefined;
    const runtime = getDynamaxRuntime(runtimes, ctx);
    runtime.runningWorkflow = undefined;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return undefined;
  });

  pi.on("context", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    const messages = appendDynamaxContextReminder(event.messages, runtime.state);
    if (messages === event.messages) return undefined;
    return { messages };
  });

  if (shortcuts.inspector) {
    pi.registerShortcut(shortcuts.inspector, {
      description: "Open workflow inspector",
      handler: async (ctx) => {
        await openInspector(ctx);
      },
    });
  }

  pi.registerCommand("workflow:dynamax", {
    description: "Toggle Dynamax workflow orchestration: /workflow:dynamax [on|off|status]",
    getArgumentCompletions: (argumentPrefix) => completeCurrentArgument(argumentPrefix, DYNAMAX_ACTION_COMPLETIONS),
    handler: async (args, ctx) => {
      const runtime = getDynamaxRuntime(runtimes, ctx);
      const action = args.trim().toLowerCase();
      if (action === "") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}. Usage: /workflow:dynamax [on|off|status]`, "info");
        return;
      }
      if (action === "on") {
        enableDynamaxSticky(runtime.state);
        updateDynamaxSurfaces(ctx, runtime, shortcuts);
        ctx.ui.notify("Dynamax workflow orchestration is on for this session", "info");
        return;
      }
      if (action === "off") {
        clearDynamax(runtime.state);
        updateDynamaxSurfaces(ctx, runtime, shortcuts);
        ctx.ui.notify("Dynamax workflow orchestration is off", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /workflow:dynamax [on|off|status]", "warning");
    },
  });
}

export function updateDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">, runtime: DynamaxRuntime, shortcuts: DynamaxShortcuts): void {
  if (!ctx.hasUI) return;
  if (!isDynamaxActive(runtime.state) && !runtime.runningWorkflow) {
    clearDynamaxSurfaces(ctx);
    return;
  }

  const status = dynamaxWidgetLine(runtime.state, shortcuts.inspector, runtime.runningWorkflow);
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, status);
}

export function clearDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, undefined);
}

function workflowLabel(args: unknown): string {
  if (!isRecord(args)) return "workflow";
  const name = args.name;
  if (typeof name === "string" && name.trim()) return name.trim();
  const script = args.script;
  if (typeof script === "string" && script.trim()) return "inline workflow";
  return "workflow";
}

function createDynamaxContextMessage(): AgentMessage {
  return {
    role: "custom",
    customType: DYNAMAX_CONTEXT_CUSTOM_TYPE,
    content: DYNAMAX_REMINDER.trim(),
    display: false,
    details: { dynamax: true, sticky: true },
    timestamp: Date.now(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
