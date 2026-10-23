import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionShortcut,
  type RegisteredCommand,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  Component,
  EditorComponent,
  EditorTheme,
  KeyId,
  TUI,
} from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import {
  DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  resolveDynamaxShortcuts,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";
import {
  applyDynamaxPromptSection,
  createDynamaxTurnBudget,
  parseBudgetDirective,
  resolveTurnBudget,
  type DynamaxHandle,
  clearDynamax,
  createDynamaxRuntime,
  createDynamaxState,
  DYNAMAX_REMINDER,
  DYNAMAX_SECTION,
  DYNAMAX_STICKY_REMINDER,
  DYNAMAX_STATUS_KEY,
  type DynamaxRegistrationOptions,
  type DynamaxRuntimeStore,
  dynamaxStatusText,
  enableDynamaxSticky,
  getDynamaxRuntime,
  hasDynamaxToken,
  isDynamaxActive,
  markDynamaxOneShot,
  registerDynamax,
  updateDynamaxSurfaces,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax.ts";
import { sessionKey } from "../.pi/extensions/pi-workflow-engine/src/session-identity.ts";
import {
  decorateDynamaxEditor,
  DYNAMAX_ANIMATION_FRAME_MS,
  highlightDynamaxTokens,
  resolveDynamaxEffect,
  type DynamaxAnimationScheduler,
} from "../.pi/extensions/pi-workflow-engine/src/ui/dynamax-editor-decoration.ts";

function createStubEditor(initialText = ""): EditorComponent {
  let text = initialText;
  return {
    getText: () => text,
    setText: (value: string) => {
      text = value;
    },
    handleInput: (data: string) => {
      text += data;
    },
    render: () => [`custom:${text}`],
    invalidate: () => {},
  };
}

interface FakeScheduledAnimation {
  readonly dueAt: number;
  readonly callback: () => void;
}

function createFakeAnimationScheduler(): DynamaxAnimationScheduler & {
  advance(ms: number): void;
  pending(): number;
} {
  let now = 0;
  const scheduled = new Set<FakeScheduledAnimation>();
  return {
    now: () => now,
    schedule(callback, delayMs) {
      const task = { dueAt: now + delayMs, callback };
      scheduled.add(task);
      return () => {
        scheduled.delete(task);
      };
    },
    advance(ms) {
      now += ms;
      while (true) {
        const due = [...scheduled]
          .filter((task) => task.dueAt <= now)
          .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!due) return;
        scheduled.delete(due);
        due.callback();
      }
    },
    pending: () => scheduled.size,
  };
}

interface CapturedCommand {
  description?: string;
  getArgumentCompletions?: (argumentPrefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: RegisteredCommand["handler"];
}

interface CapturedShortcut {
  description?: string;
  handler: ExtensionShortcut["handler"];
}

type CapturedHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface CapturePiResult {
  commands: Map<string, CapturedCommand>;
  shortcuts: Map<KeyId, CapturedShortcut>;
  handlers: Map<string, CapturedHandler[]>;
  handle: DynamaxHandle;
}

interface FakeUiState {
  notifications: Array<{ message: string; type: "info" | "warning" | "error" | undefined }>;
  statuses: Map<string, string | undefined>;
  editorComponentChanges: number;
  renderRequests: number;
  editorFactory: EditorFactory | undefined;
  editor: EditorComponent | undefined;
  customComponent: Component | undefined;
}

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorKeybindings = Parameters<EditorFactory>[2];

function captureDynamax(
  shortcut: KeyId | null = DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  openInspector?: (ctx: ExtensionContext) => void | Promise<void>,
  registrationOptions: Omit<DynamaxRegistrationOptions, "openInspector"> = {},
): CapturePiResult {
  const commands = new Map<string, CapturedCommand>();
  const shortcuts = new Map<KeyId, CapturedShortcut>();
  const handlers = new Map<string, CapturedHandler[]>();
  const fakePi = {
    on: (event: string, handler: CapturedHandler) => {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    registerCommand: (name: string, command: CapturedCommand) => {
      commands.set(name, command);
    },
    registerShortcut: (key: KeyId, shortcutOptions: CapturedShortcut) => {
      shortcuts.set(key, shortcutOptions);
    },
    registerTool: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: () => {},
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "medium",
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, emit: async () => {} },
  } as unknown as ExtensionAPI;

  const handle = registerDynamax(fakePi, { inspector: shortcut, results: null }, { effect: "shine", ...registrationOptions, openInspector: openInspector ?? (() => {}) });
  return { commands, shortcuts, handlers, handle };
}

/** Run every handler registered for `event`, as pi does; an event with none is a no-op. */
async function emit(captured: CapturePiResult, event: string, payload: unknown, ctx: ExtensionContext): Promise<void> {
  for (const handler of captured.handlers.get(event) ?? []) await handler(payload, ctx);
}

function createFakeContext(
  sessionId: string,
  hasUI = true,
  initialEditorFactory?: EditorFactory,
): { ctx: ExtensionCommandContext; ui: FakeUiState } {
  const uiState: FakeUiState = {
    notifications: [],
    statuses: new Map(),
    editorComponentChanges: 0,
    renderRequests: 0,
    editorFactory: initialEditorFactory,
    editor: undefined,
    customComponent: undefined,
  };
  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => {
      uiState.renderRequests++;
    },
  } as Pick<TUI, "requestRender">;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as ExtensionContext["ui"]["theme"];
  const editorTheme = {
    borderColor: (text: string) => text,
    selectList: {},
  } as EditorTheme;
  const keybindings = {} as EditorKeybindings;
  if (initialEditorFactory) {
    uiState.editor = initialEditorFactory(tui as unknown as TUI, editorTheme, keybindings);
  }
  const ctx = {
    hasUI,
    mode: hasUI ? "tui" : "print",
    cwd: process.cwd(),
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => {
        uiState.notifications.push({ message, type });
      },
      setStatus: (key: string, text: string | undefined) => {
        uiState.statuses.set(key, text);
      },
      setEditorComponent: (factory: EditorFactory | undefined) => {
        uiState.editorComponentChanges += 1;
        const text = uiState.editor?.getText() ?? "";
        uiState.editorFactory = factory;
        uiState.editor = factory ? factory(tui as unknown as TUI, editorTheme, keybindings) : undefined;
        uiState.editor?.setText(text);
      },
      getEditorComponent: () => uiState.editorFactory,
      custom: async <T>(
        factory: (tuiArg: TUI, themeArg: ExtensionContext["ui"]["theme"], keybindings: never, done: (result: T) => void) => Component,
      ): Promise<T> => {
        uiState.customComponent = factory(tui as unknown as TUI, theme, undefined as never, () => {});
        return undefined as T;
      },
      theme,
    },
    modelRegistry: { find: () => undefined },
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
  } as unknown as ExtensionCommandContext;

  return { ctx, ui: uiState };
}

test("hasDynamaxToken matches exact dynamax word case-insensitively", () => {
  assert.equal(hasDynamaxToken("dynamax this"), true);
  assert.equal(hasDynamaxToken("please DYNAMAX!"), true);
  assert.equal(hasDynamaxToken("(dynamax)"), true);
  assert.equal(hasDynamaxToken("notdynamax"), false);
  assert.equal(hasDynamaxToken("dynamaxing"), false);
  assert.equal(hasDynamaxToken("pre_dynamax"), false);
  assert.equal(hasDynamaxToken("dynamax_mode"), false);
});

test("Dynamax installs pi's stock-compatible highlighted editor", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax startup and shutdown handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await sessionStart({}, ctx);
  assert.equal(ui.editorComponentChanges, 1);
  assert.ok(ui.editor instanceof CustomEditor);
  assert.deepEqual(ui.notifications, []);

  ui.editor.setText("dynamax inspect this branch");
  const rendered = ui.editor.render(80).join("\n");
  assert.match(rendered, /\x1b\[38;2;/);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, undefined);
  assert.equal(ui.editorComponentChanges, 2);
});

test("Dynamax cancels a pending shine sweep on session shutdown", async () => {
  const scheduler = createFakeAnimationScheduler();
  const captured = captureDynamax(DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT, undefined, {
    animationScheduler: scheduler,
    effect: "shine",
  });
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await sessionStart({}, ctx);
  if (!ui.editor) throw new Error("expected decorated editor");
  ui.editor.setText("dynamax");
  ui.editor.render(80);
  assert.equal(scheduler.pending(), 1);

  await sessionShutdown({}, ctx);
  assert.equal(scheduler.pending(), 0);
  scheduler.advance(DYNAMAX_ANIMATION_FRAME_MS);
  assert.equal(ui.renderRequests, 0);
});

test("Dynamax highlights only standalone tokens", () => {
  const prompt = "dynamax notdynamax dynamaxing dynamax_mode (DYNAMAX)";
  const highlighted = highlightDynamaxTokens(prompt);
  const colorStarts = highlighted.match(/\x1b\[38;2;/g) ?? [];

  assert.equal(colorStarts.length, "dynamaxDYNAMAX".length);
  assert.equal(highlighted.replace(/\x1b\[[0-9;]*m/g, ""), prompt);
  assert.equal(visibleWidth(highlightDynamaxTokens(prompt, 3)), visibleWidth(prompt));
  assert.equal(highlightDynamaxTokens("notdynamax dynamaxing dynamax_mode"), "notdynamax dynamaxing dynamax_mode");

  const cursorInsideToken = "\x1b[31mdyna\x1b_pi:c\x07\x1b[7mm\x1b[0max";
  const highlightedCursorLine = highlightDynamaxTokens(cursorInsideToken);
  assert.equal(highlightedCursorLine.match(/\x1b\[38;2;/g)?.length, "dynamax".length);
  assert.equal(highlightedCursorLine.match(/\x1b_pi:c\x07/g)?.length, 1);

  const styledSuffix = highlightDynamaxTokens("\x1b[31mdynamax suffix\x1b[0m");
  assert.match(styledSuffix, /\x1b\[31m suffix/);
  assert.doesNotMatch(styledSuffix, /\x1b\[39m suffix/);

  const compoundSuffix = highlightDynamaxTokens("\x1b[1;31;44m\x1b[49mdynamax suffix\x1b[0m");
  assert.match(compoundSuffix, /\x1b\[1;31;44m\x1b\[49m suffix/);

  const indexedSuffix = highlightDynamaxTokens("\x1b[38;5;123;48;5;44m\x1b[49mdynamax suffix\x1b[0m");
  assert.match(indexedSuffix, /\x1b\[38;5;123;48;5;44m\x1b\[49m suffix/);

  const rgbSuffix = highlightDynamaxTokens("\x1b[1;38;2;10;20;30;48;2;40;50;60m\x1b[49mdynamax suffix\x1b[0m");
  assert.match(rgbSuffix, /\x1b\[1;38;2;10;20;30;48;2;40;50;60m\x1b\[49m suffix/);

  const colonRgbSuffix = highlightDynamaxTokens("\x1b[38:2::70:80:90;48:5:44m\x1b[49mdynamax suffix\x1b[0m");
  assert.match(colonRgbSuffix, /\x1b\[38:2::70:80:90;48:5:44m\x1b\[49m suffix/);
});

test("Dynamax runs one bounded moving-shine sweep and returns to static highlighting", () => {
  const scheduler = createFakeAnimationScheduler();
  const editor = createStubEditor("dynamax");
  let renderRequests = 0;
  let latest = "";
  const decoration = decorateDynamaxEditor(
    editor,
    () => {
      renderRequests++;
      latest = editor.render(80)[0]!;
    },
    { scheduler, effect: "shine" },
  );

  const initial = editor.render(80)[0]!;
  assert.equal(initial, highlightDynamaxTokens("custom:dynamax", 0));
  assert.equal(scheduler.pending(), 1);

  for (let shinePosition = 1; shinePosition < "dynamax".length; shinePosition++) {
    scheduler.advance(DYNAMAX_ANIMATION_FRAME_MS);
    assert.equal(latest, highlightDynamaxTokens("custom:dynamax", shinePosition));
    assert.equal(scheduler.pending(), 1);
  }

  scheduler.advance(DYNAMAX_ANIMATION_FRAME_MS);
  assert.equal(latest, highlightDynamaxTokens("custom:dynamax"));
  assert.equal(renderRequests, "dynamax".length);
  assert.equal(scheduler.pending(), 0);

  editor.render(80);
  assert.equal(scheduler.pending(), 0, "ordinary rerenders must not restart a completed sweep");
  decoration.dispose();
  assert.equal(editor.render(80)[0], "custom:dynamax");
});

test("Dynamax static highlighting does not schedule animation", () => {
  const staticScheduler = createFakeAnimationScheduler();
  const staticEditor = createStubEditor("dynamax");
  decorateDynamaxEditor(staticEditor, () => {}, { scheduler: staticScheduler, effect: "static" });
  assert.equal(staticEditor.render(80)[0], highlightDynamaxTokens("custom:dynamax"));
  assert.equal(staticScheduler.pending(), 0);
});

test("resolveDynamaxEffect honors explicit preferences and NO_COLOR", () => {
  assert.equal(resolveDynamaxEffect({}), "shine");
  assert.equal(resolveDynamaxEffect({ PI_DYNAMAX_EFFECT: " static " }), "static");
  assert.equal(resolveDynamaxEffect({ PI_DYNAMAX_EFFECT: "off" }), "off");
  assert.equal(resolveDynamaxEffect({ NO_COLOR: "1" }), "off");
  assert.equal(resolveDynamaxEffect({ NO_COLOR: " " }), "off");
  assert.equal(resolveDynamaxEffect({ NO_COLOR: "" }), "shine");
  assert.equal(resolveDynamaxEffect({ PI_DYNAMAX_EFFECT: "shine", NO_COLOR: "1" }), "shine");
});

test("Dynamax composes an existing editor and restores it on shutdown", async () => {
  const existingFactory: EditorFactory = () => createStubEditor();
  const captured = captureDynamax();
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a", true, existingFactory);

  await sessionStart({}, ctx);
  assert.notEqual(ui.editorFactory, existingFactory);
  if (!ui.editor) throw new Error("expected composed editor");
  ui.editor.handleInput("dynamax");
  assert.equal(ui.editor.getText(), "dynamax");
  assert.match(ui.editor.render(80).join("\n"), /custom:.*\x1b\[38;2;/);
  assert.deepEqual(ui.notifications, []);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, existingFactory);
  assert.ok(ui.editor);
  assert.equal(ui.editor.getText(), "dynamax");
});

test("Dynamax falls back to a highlighted stock editor when decoration fails", async () => {
  const existingFactory: EditorFactory = () => {
    const editor = createStubEditor();
    Object.defineProperty(editor, "render", { value: editor.render, writable: false });
    return editor;
  };
  const captured = captureDynamax();
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a", true, existingFactory);

  await sessionStart({}, ctx);
  assert.ok(ui.editor instanceof CustomEditor);
  ui.editor.setText("dynamax");
  assert.match(ui.editor.render(80).join("\n"), /\x1b\[38;2;/);
  assert.match(ui.notifications.at(-1)?.message ?? "", /could not decorate.*highlighting stays enabled/);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, existingFactory);
  assert.ok(ui.editor);
  assert.equal(ui.editor.getText(), "dynamax");
});

test("Dynamax leaves the editor untouched when highlighting is off", async () => {
  const existingFactory: EditorFactory = () => createStubEditor();
  const captured = captureDynamax(DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT, undefined, { effect: "off" });
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a", true, existingFactory);

  await sessionStart({}, ctx);
  assert.equal(ui.editorFactory, existingFactory);
  assert.equal(ui.editorComponentChanges, 0);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, existingFactory);
  assert.equal(ui.editorComponentChanges, 0);
});

test("Dynamax warns and falls back when an existing editor cannot be composed", async () => {
  const captured = captureDynamax();
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");
  ui.editorFactory = () => {
    throw new Error("broken editor");
  };

  await sessionStart({}, ctx);
  assert.ok(ui.editor instanceof CustomEditor);
  ui.editor.setText("dynamax");
  assert.match(ui.editor.render(80).join("\n"), /\x1b\[38;2;/);
  assert.match(ui.notifications.at(-1)?.message ?? "", /could not compose.*broken editor/);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, undefined);
});

test("Dynamax does not animate or overwrite a later editor replacement", async () => {
  const scheduler = createFakeAnimationScheduler();
  const captured = captureDynamax(DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT, undefined, {
    animationScheduler: scheduler,
    effect: "shine",
  });
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await sessionStart({}, ctx);
  if (!ui.editor) throw new Error("expected decorated editor");
  ui.editor.setText("dynamax");
  ui.editor.render(80);
  assert.equal(scheduler.pending(), 1);

  const lateFactory: EditorFactory = () => createStubEditor();
  ctx.ui.setEditorComponent(lateFactory);
  assert.equal(ui.editorFactory, lateFactory);
  scheduler.advance(DYNAMAX_ANIMATION_FRAME_MS);
  assert.equal(ui.renderRequests, 0);
  assert.equal(scheduler.pending(), 0);

  await sessionShutdown({}, ctx);
  assert.equal(ui.editorFactory, lateFactory);
  assert.equal(ui.editorComponentChanges, 2);
});

test("Dynamax command completes native on, off, and status arguments", async () => {
  const command = captureDynamax().commands.get("workflow:dynamax");
  if (!command?.getArgumentCompletions) throw new Error("expected Dynamax argument completions");
  const all = await command.getArgumentCompletions("");
  assert.deepEqual(all?.map((item) => item.value), ["on", "off", "status"]);
  const status = await command.getArgumentCompletions("st");
  assert.deepEqual(status?.map((item) => item.value), ["status"]);
  assert.equal(await command.getArgumentCompletions("on extra"), null);
  const completions = await command.getArgumentCompletions("o");
  assert.deepEqual(completions?.map((item) => item.value), ["on", "off"]);
});

test("dynamax one-shot state is consumed by the prompt section", () => {
  const state = createDynamaxState();
  markDynamaxOneShot(state);

  const sections: Record<string, string> = {};
  assert.equal(applyDynamaxPromptSection(sections, state), true);

  assert.equal(sections[DYNAMAX_SECTION], DYNAMAX_REMINDER);
  assert.equal(state.oneShotPending, false);
  const nextRun: Record<string, string> = {};
  assert.equal(applyDynamaxPromptSection(nextRun, state), false);
  assert.deepEqual(nextRun, {});
});

test("the dynamax reminder carries only the opt-in, not the authoring rules", () => {
  // The authoring rules live in the workflow-authoring skill that the tool's guidelines point to.
  assert.match(DYNAMAX_REMINDER, /workflow tool is permitted/);
  assert.doesNotMatch(DYNAMAX_REMINDER, /maxItems|gap-analysis|profile/);
});

test("dynamax sticky mode remains active until cleared", () => {
  const state = createDynamaxState();
  enableDynamaxSticky(state);

  assert.equal(isDynamaxActive(state), true);
  const sections: Record<string, string> = {};
  applyDynamaxPromptSection(sections, state);
  assert.equal(sections[DYNAMAX_SECTION], DYNAMAX_STICKY_REMINDER);
  assert.equal(state.sticky, true);
  assert.equal(isDynamaxActive(state), true);

  clearDynamax(state);
  assert.equal(isDynamaxActive(state), false);
});

test("sticky Dynamax is a standing default, distinct from the one-request opt-in", () => {
  assert.match(DYNAMAX_STICKY_REMINDER, /on for this session/);
  assert.match(DYNAMAX_STICKY_REMINDER, /by default/);
  assert.match(DYNAMAX_STICKY_REMINDER, /one single-phase workflow per phase/);
  assert.notEqual(DYNAMAX_STICKY_REMINDER, DYNAMAX_REMINDER);

  // A typed `dynamax` while sticky is covered by the standing default.
  const state = createDynamaxState();
  enableDynamaxSticky(state);
  markDynamaxOneShot(state);
  const sections: Record<string, string> = {};
  applyDynamaxPromptSection(sections, state, "user");
  assert.equal(sections[DYNAMAX_SECTION], DYNAMAX_STICKY_REMINDER);
  assert.equal(state.oneShotPending, false);
});

test("a run a custom message starts keeps sticky Dynamax but never consumes the one-shot", () => {
  const sticky = createDynamaxState();
  enableDynamaxSticky(sticky);
  const custom: Record<string, string> = {};
  assert.equal(applyDynamaxPromptSection(custom, sticky, "custom"), true);
  assert.equal(custom[DYNAMAX_SECTION], DYNAMAX_STICKY_REMINDER);

  const armed = createDynamaxState();
  markDynamaxOneShot(armed);
  const triggered: Record<string, string> = {};
  assert.equal(applyDynamaxPromptSection(triggered, armed, "custom"), false);
  assert.deepEqual(triggered, {});
  assert.equal(armed.oneShotPending, true, "the one-shot waits for the user's prompt");
  const prompted: Record<string, string> = {};
  assert.equal(applyDynamaxPromptSection(prompted, armed, "user"), true);
  assert.equal(prompted[DYNAMAX_SECTION], DYNAMAX_REMINDER);
});

test("the before_agent_start hook passes the run's message type through", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  if (!input || !beforeAgentStart) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx } = createFakeContext("message-type");

  await input({ source: "interactive", text: "dynamax look into it" }, ctx);
  const custom: Record<string, string> = {};
  await beforeAgentStart({ messageType: "custom", systemPrompt: "base", systemPromptOptions: { selectedTools: ["workflow"], sections: custom } }, ctx);
  assert.equal(custom[DYNAMAX_SECTION], undefined);
  const user: Record<string, string> = {};
  await beforeAgentStart({ messageType: "user", systemPrompt: "base", systemPromptOptions: { selectedTools: ["workflow"], sections: user } }, ctx);
  assert.equal(user[DYNAMAX_SECTION], DYNAMAX_REMINDER);
});

test("a run without the workflow tool gets no Dynamax section and leaves the one-shot armed", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  if (!input || !beforeAgentStart) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx } = createFakeContext("subagent");

  // A subagent's prompt arrives as an interactive input, and its session withholds the workflow tool.
  await input({ source: "interactive", text: "review src/dynamax.ts for regressions" }, ctx);
  const subagent: Record<string, string> = {};
  const result = await beforeAgentStart({ messageType: "user", systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"], sections: subagent } }, ctx);
  assert.equal(result, undefined);
  assert.deepEqual(subagent, {});
  assert.equal(captured.handle.isActive(ctx), true, "the one-shot still waits for a run that can use it");

  const host: Record<string, string> = {};
  await beforeAgentStart({ messageType: "user", systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "workflow"], sections: host } }, ctx);
  assert.equal(host[DYNAMAX_SECTION], DYNAMAX_REMINDER);
});

test("/workflow:dynamax with no argument toggles sticky mode", async () => {
  const command = captureDynamax().commands.get("workflow:dynamax");
  if (!command) throw new Error("expected /workflow:dynamax command");
  const { ctx, ui } = createFakeContext("toggle");

  await command.handler("", ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax");
  assert.match(ui.notifications.at(-1)?.message ?? "", /on for this session/);

  await command.handler("", ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
  assert.match(ui.notifications.at(-1)?.message ?? "", /is off/);

  await command.handler("sideways", ctx);
  assert.match(ui.notifications.at(-1)?.message ?? "", /no argument toggles sticky mode/);
});

test("a standalone +N directive sets a turn budget; other plus signs do not", () => {
  assert.equal(parseBudgetDirective("+500k review this"), 500_000);
  assert.equal(parseBudgetDirective("dynamax +1.5m"), 1_500_000);
  assert.equal(parseBudgetDirective("go +2M."), 2_000_000);
  assert.equal(parseBudgetDirective("spend\t+250000, then stop"), 250_000);
  assert.equal(parseBudgetDirective("+2.3k"), 2_300);
  for (const text of ["a+500k", "+500kb", "+500 k", "(+500k)", "C++ 20", "+1 to that", "+0.5k", "nothing here"]) {
    assert.equal(parseBudgetDirective(text), undefined, text);
  }
});

test("a turn budget pool caps every run until it is spent; without one it adds no budget", () => {
  const range = { min: 1, max: 1_000_000 };
  const pool = createDynamaxTurnBudget(50_000);
  assert.deepEqual(resolveTurnBudget(undefined, range), { kind: "budget", budget: undefined });
  assert.deepEqual(resolveTurnBudget(pool, range), { kind: "budget", budget: 50_000 });
  pool.spend(30_000);
  pool.spend(Number.NaN);
  assert.deepEqual(resolveTurnBudget(pool, range), { kind: "budget", budget: 20_000 });
  assert.deepEqual(resolveTurnBudget(createDynamaxTurnBudget(5_000_000), range), { kind: "budget", budget: 1_000_000 });
  pool.spend(25_000);
  assert.equal(pool.remaining(), 0);
  assert.deepEqual(resolveTurnBudget(pool, range), { kind: "spent", total: 50_000 });
});

test("the input hook sets the turn pool from user prompts only, and the run's settling clears it", async () => {
  const captured = captureDynamax();
  const input = captured.handlers.get("input")?.[0];
  if (!input) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx } = createFakeContext("turn-budget");

  await input({ source: "extension", text: "+500k from an extension" }, ctx);
  assert.equal(captured.handle.turnBudget(ctx), undefined);
  await input({ source: "interactive", text: "dynamax +500k audit the parser" }, ctx);
  await emit(captured, "before_agent_start", { messageType: "user", systemPrompt: "base", systemPromptOptions: { selectedTools: ["workflow"], sections: {} } }, ctx);
  assert.equal(captured.handle.turnBudget(ctx)?.total, 500_000);

  // pi ends a loop with agent_end and continues the same run after a provider retry or overflow compaction.
  await emit(captured, "agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(captured.handle.turnBudget(ctx)?.total, 500_000);
  assert.equal(captured.handle.isActive(ctx), true);

  await emit(captured, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
  assert.equal(captured.handle.turnBudget(ctx), undefined);
  assert.equal(captured.handle.isActive(ctx), false);
});

test("resolveDynamaxShortcuts reads configurable workflow UI shortcuts", () => {
  const shortcuts = resolveDynamaxShortcuts(resolve("tests/fixtures/dynamax-shortcuts.json"));

  assert.deepEqual(shortcuts, { inspector: "ctrl+shift+x", results: "ctrl+shift+y" });
});

test("resolveDynamaxShortcuts rejects invalid keys and prevents shortcut collisions", () => {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    assert.deepEqual(resolveDynamaxShortcuts(resolve("tests/fixtures/dynamax-shortcuts-invalid.json")), {
      inspector: DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
      results: null,
    });
    assert.deepEqual(resolveDynamaxShortcuts(resolve("tests/fixtures/dynamax-shortcuts-collision.json")), {
      inspector: "ctrl+shift+x",
      results: null,
    });
  } finally {
    console.warn = warn;
  }

  assert.equal(warnings.length, 2);
  assert.match(warnings[0] ?? "", /Invalid inspector shortcut/);
  assert.match(warnings[1] ?? "", /disabling the results shortcut/);
});

test("dynamax runtime store isolates state by session", () => {
  const store: DynamaxRuntimeStore = new Map();
  const first = createFakeContext("session-a");
  const second = createFakeContext("session-b");

  const firstRuntime = getDynamaxRuntime(store, first.ctx);
  const secondRuntime = getDynamaxRuntime(store, second.ctx);
  enableDynamaxSticky(firstRuntime.state);

  assert.equal(sessionKey(first.ctx), "session-a");
  assert.equal(firstRuntime.state.sticky, true);
  assert.equal(secondRuntime.state.sticky, false);
});

test("registerDynamax registers a first-class shortcut that opens the workflow inspector", async () => {
  let inspectorOpened = 0;
  const captured = captureDynamax("ctrl+shift+x", () => {
    inspectorOpened++;
  });
  const command = captured.commands.get("workflow:dynamax");
  const shortcut = captured.shortcuts.get("ctrl+shift+x");
  const { ctx, ui } = createFakeContext("session-a");

  assert.ok(command, "expected /workflow:dynamax command");
  assert.equal(shortcut?.description, "Open workflow inspector");

  await shortcut?.handler(ctx);
  assert.equal(inspectorOpened, 1);

  await command.handler("status", ctx);
  assert.equal(ui.customComponent, undefined);
  assert.match(ui.notifications.at(-1)?.message ?? "", /Dynamax sticky off/);
});

test("dynamax command state stays isolated per session", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const command = captured.commands.get("workflow:dynamax");
  if (!command) throw new Error("expected /workflow:dynamax command");
  const first = createFakeContext("session-a");
  const second = createFakeContext("session-b");

  await command.handler("on", first.ctx);
  await command.handler("status", second.ctx);

  assert.equal(first.ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax");
  assert.equal(second.ui.notifications.at(-1)?.message, "Dynamax sticky off; one-shot clear");
});

test("dynamax status states only the mode: sticky, armed for the next prompt, or active this turn", () => {
  const theme = createFakeContext("status-modes").ctx.ui.theme;
  const sticky = createDynamaxState();
  enableDynamaxSticky(sticky);
  markDynamaxOneShot(sticky);
  assert.equal(dynamaxStatusText(sticky, theme), "◆ dynamax");

  const armed = createDynamaxState();
  markDynamaxOneShot(armed);
  assert.equal(dynamaxStatusText(armed, theme), "◆ dynamax · next prompt");

  const turn = createDynamaxState();
  markDynamaxOneShot(turn);
  applyDynamaxPromptSection({}, turn);
  assert.equal(dynamaxStatusText(turn, theme), "◆ dynamax · this turn");
});

test("one-shot Dynamax status remains visible for the active turn", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  if (!input || !beforeAgentStart) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await input({ source: "interactive", text: "dynamax inspect this branch" }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax · next prompt");

  const sections: Record<string, string> = {};
  const result = await beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["workflow"], sections } }, ctx);
  // A section patch keeps pi's cached prompt head; returning systemPrompt would force a full replacement.
  assert.equal(result, undefined);
  assert.equal(sections[DYNAMAX_SECTION], DYNAMAX_REMINDER);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax · this turn");

  await emit(captured, "agent_end", { type: "agent_end", messages: [] }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax · this turn", "a loop ending is not the run settling");
  await emit(captured, "agent_settled", { type: "agent_settled", aborted: false }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});

test("Dynamax appends to a prompt an earlier extension forced, since pi renders no sections then", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  if (!input || !beforeAgentStart) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx } = createFakeContext("forced-prompt");

  await input({ source: "interactive", text: "dynamax review this" }, ctx);
  const result = await beforeAgentStart({ systemPrompt: "Forced.", systemPromptOptions: { selectedTools: ["workflow"], sections: {}, forceSystemPrompt: "Forced." } }, ctx);

  assert.deepEqual(result, { systemPrompt: `Forced.\n\n<${DYNAMAX_SECTION}>\n${DYNAMAX_REMINDER}\n</${DYNAMAX_SECTION}>` });
});

test("updateDynamaxSurfaces clears inactive UI", () => {
  const runtime = createDynamaxRuntime();
  const { ctx, ui } = createFakeContext("session-a");

  enableDynamaxSticky(runtime.state);
  updateDynamaxSurfaces(ctx, runtime);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax");

  clearDynamax(runtime.state);
  updateDynamaxSurfaces(ctx, runtime);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});
