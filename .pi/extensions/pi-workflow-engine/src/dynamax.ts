import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, EditorComponent, KeyId, TUI } from "@earendil-works/pi-tui";
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
export interface DynamaxRegistrationOptions {
  openInspector?: (ctx: ExtensionContext) => Promise<void> | void;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;
export const DYNAMAX_STATUS_KEY = "dynamax";
export const DYNAMAX_WIDGET_KEY = "workflow-dynamax";
export const DYNAMAX_ANIMATION_INTERVAL_MS = 80;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface DynamaxEditorInstallation {
  factory: EditorFactory;
  previousFactory: EditorFactory | undefined;
  setOwnershipCleanup(cleanup: () => void): void;
  dispose(): void;
}

interface DynamaxEditorFactoryMetadata {
  previousFactory: EditorFactory | undefined;
  dispose(): void;
}

const DYNAMAX_EDITOR_FACTORY = Symbol.for("pi-workflow-engine.dynamax-editor-factory");
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

const DYNAMAX_ACTION_COMPLETIONS: readonly AutocompleteItem[] = [
  { value: "on", label: "on", description: "Keep Dynamax enabled for this session" },
  { value: "off", label: "off", description: "Disable sticky and pending Dynamax modes" },
  { value: "status", label: "status", description: "Show the current Dynamax state" },
];

class DynamaxAnimation {
  private timer: ReturnType<typeof setInterval> | undefined;
  private frame = 0;

  constructor(
    private readonly tui: Pick<TUI, "requestRender">,
    private readonly ownsEditor: () => boolean = () => true,
  ) {}

  sync(text: string): void {
    if (this.ownsEditor() && hasDynamaxToken(text)) {
      this.start();
    } else {
      this.stop();
    }
  }

  render(lines: string[]): string[] {
    if (!this.ownsEditor()) {
      this.stop();
      return lines;
    }
    return lines.map((line) => highlightDynamaxTokens(line, this.frame));
  }

  dispose(): void {
    this.stop();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.ownsEditor()) {
        this.stop();
        return;
      }
      this.frame = (this.frame + 1) % DYNAMAX_COLORS.length;
      this.tui.requestRender();
    }, DYNAMAX_ANIMATION_INTERVAL_MS);
    this.timer.unref?.();
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.frame = 0;
  }
}

/** Stock pi editor behavior with a render-only animated Dynamax cue. */
export class DynamaxEditor extends CustomEditor {
  private readonly dynamaxAnimation: DynamaxAnimation;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    ownsEditor: () => boolean = () => true,
  ) {
    super(tui, theme, keybindings);
    this.dynamaxAnimation = new DynamaxAnimation(this.tui, ownsEditor);
  }

  override handleInput(data: string): void {
    super.handleInput(data);
    this.dynamaxAnimation.sync(this.getText());
  }

  override setText(text: string): void {
    super.setText(text);
    this.dynamaxAnimation.sync(this.getText());
  }

  override render(width: number): string[] {
    this.dynamaxAnimation.sync(this.getText());
    return this.dynamaxAnimation.render(super.render(width));
  }

  dispose(): void {
    this.dynamaxAnimation.dispose();
  }
}

export function highlightDynamaxTokens(line: string, frame: number): string {
  const { visibleText, rawPositions } = mapVisibleCharacters(line);
  const insertions = new Map<number, string>();
  DYNAMAX_RENDER_PATTERN.lastIndex = 0;
  for (const match of visibleText.matchAll(DYNAMAX_RENDER_PATTERN)) {
    const prefix = match[1];
    const token = match[2];
    if (match.index === undefined || prefix === undefined || token === undefined) continue;
    const visibleStart = match.index + prefix.length;
    for (let index = 0; index < token.length; index++) {
      const rawPosition = rawPositions[visibleStart + index];
      const color = DYNAMAX_COLORS[(index + normalizedFrame(frame)) % DYNAMAX_COLORS.length];
      if (rawPosition === undefined || !color) continue;
      const shine = index === 0 ? 0.45 : 0;
      appendInsertion(insertions, rawPosition, foregroundColor(color, shine));
    }
    const restorePosition = rawPositions[visibleStart + token.length] ?? line.length;
    appendInsertion(insertions, restorePosition, activeForegroundAt(line, restorePosition));
  }
  DYNAMAX_RENDER_PATTERN.lastIndex = 0;
  if (insertions.size === 0) return line;

  let highlighted = "";
  for (let rawPosition = 0; rawPosition <= line.length; rawPosition++) {
    highlighted += insertions.get(rawPosition) ?? "";
    if (rawPosition < line.length) highlighted += line[rawPosition];
  }
  return highlighted;
}

export function completeDynamaxAction(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart().toLowerCase();
  if (prefix.includes(" ")) return null;
  return DYNAMAX_ACTION_COMPLETIONS.filter((item) => item.value.startsWith(prefix)).map((item) => ({ ...item }));
}

function normalizedFrame(frame: number): number {
  return ((frame % DYNAMAX_COLORS.length) + DYNAMAX_COLORS.length) % DYNAMAX_COLORS.length;
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
  const parameters = rawParameters === "" ? [0] : rawParameters.split(";").map(sgrParameter);
  let state: "unchanged" | "default" | "color" = "unchanged";
  for (let index = 0; index < parameters.length; index++) {
    const parameter = parameters[index];
    if (parameter === 0 || parameter === 39) {
      state = "default";
      continue;
    }
    if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
      state = "color";
      continue;
    }
    if (parameter === 38 || parameter === 48 || parameter === 58) {
      if (parameter === 38) state = "color";
      const mode = parameters[index + 1];
      if (mode === 5) index += 2;
      else if (mode === 2) index += 4;
    }
  }
  if (state === "default") return RESET_FOREGROUND;
  if (state === "color") return sequence;
  return current;
}

function sgrParameter(parameter: string): number {
  const primary = parameter.split(":", 1)[0];
  if (primary === "") return 0;
  const parsed = Number(primary);
  return Number.isFinite(parsed) ? parsed : -1;
}

function appendInsertion(insertions: Map<number, string>, position: number, value: string): void {
  insertions.set(position, `${insertions.get(position) ?? ""}${value}`);
}

function createDynamaxEditorInstallation(
  ctx: Pick<ExtensionContext, "ui">,
  previousFactory: EditorFactory | undefined,
): DynamaxEditorInstallation {
  const editorDisposers = new Set<() => void>();
  let ownershipCleanup: (() => void) | undefined;
  const disposeEditors = (): void => {
    for (const dispose of editorDisposers) dispose();
    editorDisposers.clear();
  };
  const disposeInstallation = (): void => {
    try {
      disposeEditors();
    } finally {
      ownershipCleanup?.();
      ownershipCleanup = undefined;
    }
  };

  let factory: EditorFactory;
  const ownsEditor = (): boolean => ctx.ui.getEditorComponent() === factory;
  factory = (tui, theme, keybindings) => {
    disposeEditors();
    if (!previousFactory) {
      const editor = new DynamaxEditor(tui, theme, keybindings, ownsEditor);
      editorDisposers.add(() => editor.dispose());
      return editor;
    }

    try {
      const editor = previousFactory(tui, theme, keybindings);
      const decorated = decorateEditor(editor, tui, ownsEditor);
      editorDisposers.add(decorated.dispose);
      return decorated.editor;
    } catch (error) {
      ctx.ui.notify(
        `Dynamax could not compose the existing custom editor (${unknownErrorMessage(error)}); using pi's stock-compatible CustomEditor so highlighting stays enabled`,
        "warning",
      );
      const editor = new DynamaxEditor(tui, theme, keybindings, ownsEditor);
      editorDisposers.add(() => editor.dispose());
      return editor;
    }
  };

  const installation: DynamaxEditorInstallation = {
    factory,
    previousFactory,
    setOwnershipCleanup: (cleanup) => {
      ownershipCleanup?.();
      ownershipCleanup = cleanup;
    },
    dispose: disposeInstallation,
  };
  Object.defineProperty(factory, DYNAMAX_EDITOR_FACTORY, {
    configurable: false,
    enumerable: false,
    value: {
      previousFactory,
      dispose: disposeInstallation,
    } satisfies DynamaxEditorFactoryMetadata,
  });
  return installation;
}

function decorateEditor(
  editor: EditorComponent,
  tui: Pick<TUI, "requestRender">,
  ownsEditor: () => boolean,
): { editor: EditorComponent; dispose: () => void } {
  const animation = new DynamaxAnimation(tui, ownsEditor);
  const render = editor.render.bind(editor);
  const handleInput = editor.handleInput.bind(editor);
  const setText = editor.setText.bind(editor);
  const existingDispose = disposableEditor(editor)?.dispose.bind(editor);

  editor.render = (width: number): string[] => {
    animation.sync(editor.getText());
    return animation.render(render(width));
  };
  editor.handleInput = (data: string): void => {
    handleInput(data);
    animation.sync(editor.getText());
  };
  editor.setText = (text: string): void => {
    setText(text);
    animation.sync(editor.getText());
  };
  animation.sync(editor.getText());

  return {
    editor,
    dispose: () => {
      animation.dispose();
      existingDispose?.();
    },
  };
}

function dynamaxEditorMetadata(factory: EditorFactory | undefined): DynamaxEditorFactoryMetadata | undefined {
  if (!factory) return undefined;
  const value = (factory as EditorFactory & { [DYNAMAX_EDITOR_FACTORY]?: unknown })[DYNAMAX_EDITOR_FACTORY];
  if (!isRecord(value) || typeof value.dispose !== "function") return undefined;
  const previousFactory = value.previousFactory;
  if (previousFactory !== undefined && typeof previousFactory !== "function") return undefined;
  return {
    previousFactory: previousFactory as EditorFactory | undefined,
    dispose: value.dispose as () => void,
  };
}

function disposableEditor(editor: EditorComponent): (EditorComponent & { dispose(): void }) | undefined {
  if (!("dispose" in editor) || typeof editor.dispose !== "function") return undefined;
  return editor as EditorComponent & { dispose(): void };
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

export function setDynamaxSticky(state: DynamaxState, sticky: boolean): void {
  state.sticky = sticky;
  if (!sticky) {
    state.oneShotPending = false;
    state.turnActive = false;
  }
}

export function clearDynamax(state: DynamaxState): void {
  state.sticky = false;
  state.oneShotPending = false;
  state.turnActive = false;
}

export function consumeDynamaxOneShot(state: DynamaxState): boolean {
  const pending = state.oneShotPending;
  state.oneShotPending = false;
  return pending;
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
  let ensureEditor: (ctx: ExtensionContext) => void;
  const installEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    const currentFactory = ctx.ui.getEditorComponent();
    if (editorInstallation && editorInstallation.factory === currentFactory) return;

    editorInstallation?.dispose();
    let previousFactory = currentFactory;
    let previousMetadata = dynamaxEditorMetadata(previousFactory);
    while (previousMetadata) {
      previousMetadata.dispose();
      previousFactory = previousMetadata.previousFactory;
      previousMetadata = dynamaxEditorMetadata(previousFactory);
    }

    const nextInstallation = createDynamaxEditorInstallation(ctx, previousFactory);
    editorInstallation = nextInstallation;
    try {
      ctx.ui.setEditorComponent(nextInstallation.factory);
      nextInstallation.setOwnershipCleanup(
        ctx.ui.onTerminalInput(() => {
          ensureEditor(ctx);
          return undefined;
        }),
      );
    } catch (error) {
      nextInstallation.dispose();
      editorInstallation = undefined;
      ctx.ui.notify(`Dynamax highlighting could not be installed: ${unknownErrorMessage(error)}`, "error");
      throw error;
    }
  };
  ensureEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui") return;
    if (editorInstallation && ctx.ui.getEditorComponent() === editorInstallation.factory) return;
    if (editorInstallation) {
      ctx.ui.notify("Another extension replaced the Dynamax editor; composing it and restoring animated highlighting", "warning");
    }
    installEditor(ctx);
  };
  const uninstallEditor = (ctx: ExtensionContext): void => {
    const installation = editorInstallation;
    if (!installation) return;
    installation.dispose();
    editorInstallation = undefined;
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === installation.factory) {
      ctx.ui.setEditorComponent(installation.previousFactory);
    }
  };
  const refreshIfVisible = (ctx: ExtensionContext): void => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (isDynamaxActive(runtime.state) || runtime.runningWorkflow) {
      updateDynamaxSurfaces(ctx, runtime, shortcuts);
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
    ensureEditor(ctx);
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

  pi.on("agent_start", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_start", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_update", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("message_end", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("turn_end", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    runtime.runningWorkflow = undefined;
    if (!runtime.state.sticky) runtime.state.turnActive = false;
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (event.toolName === "workflow") {
      runtime.runningWorkflow = workflowLabel(event.args);
    }
    updateDynamaxSurfaces(ctx, runtime, shortcuts);
    return undefined;
  });

  pi.on("tool_execution_update", (_event, ctx) => {
    refreshIfVisible(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (event.toolName === "workflow") {
      runtime.runningWorkflow = undefined;
    }
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
    getArgumentCompletions: completeDynamaxAction,
    handler: async (args, ctx) => {
      const runtime = getDynamaxRuntime(runtimes, ctx);
      const action = args.trim().toLowerCase();
      if (action === "") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}. Usage: /workflow:dynamax [on|off|status]`, "info");
        return;
      }
      if (action === "on") {
        setDynamaxSticky(runtime.state, true);
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
  ctx.ui.setWidget(DYNAMAX_WIDGET_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_WIDGET_KEY, undefined);
  if (!isDynamaxActive(runtime.state) && !runtime.runningWorkflow) {
    clearDynamaxSurfaces(ctx);
    return;
  }

  const status = dynamaxWidgetLine(runtime.state, shortcuts.inspector, runtime.runningWorkflow);
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, status);
}

export function clearDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setWidget(DYNAMAX_WIDGET_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, undefined);
  ctx.ui.setStatus(DYNAMAX_WIDGET_KEY, undefined);
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
