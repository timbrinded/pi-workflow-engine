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
  ADAPTIVE_WORKFLOW_GUIDANCE,
  applyDynamaxPromptSection,
  clearDynamax,
  createDynamaxRuntime,
  createDynamaxState,
  DYNAMAX_REMINDER,
  DYNAMAX_SECTION,
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

  registerDynamax(fakePi, { inspector: shortcut, results: null }, { effect: "shine", ...registrationOptions, openInspector: openInspector ?? (() => {}) });
  return { commands, shortcuts, handlers };
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

test("dynamax reminder teaches optional adaptive multi-pass workflows", () => {
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /simple single-pass fan-out/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /structured gap-analysis agent/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /ordinary TypeScript conditionals or bounded loops/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /only when gaps exist/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /Do not generate a second pass when the first pass is sufficient/);
  // The reminder carries only the opt-in; the workflow tool's guidelines carry the authoring rules.
  assert.ok(!DYNAMAX_REMINDER.includes(ADAPTIVE_WORKFLOW_GUIDANCE));
  assert.match(DYNAMAX_REMINDER, /workflow tool is permitted/);
});

test("dynamax sticky mode remains active until cleared", () => {
  const state = createDynamaxState();
  enableDynamaxSticky(state);

  assert.equal(isDynamaxActive(state), true);
  const sections: Record<string, string> = {};
  applyDynamaxPromptSection(sections, state);
  assert.match(sections[DYNAMAX_SECTION] ?? "", /workflow tool is permitted/);
  assert.equal(state.sticky, true);
  assert.equal(isDynamaxActive(state), true);

  clearDynamax(state);
  assert.equal(isDynamaxActive(state), false);
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

  await command.handler("", ctx);
  assert.equal(ui.customComponent, undefined);
  assert.match(ui.notifications.at(-1)?.message ?? "", /Usage: \/workflow:dynamax/);
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
  const agentEnd = captured.handlers.get("agent_end")?.[0];
  if (!input || !beforeAgentStart || !agentEnd) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await input({ source: "interactive", text: "dynamax inspect this branch" }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax · next prompt");

  const sections: Record<string, string> = {};
  const result = await beforeAgentStart({ systemPrompt: "base", systemPromptOptions: { sections } }, ctx);
  // A section patch keeps pi's cached prompt head; returning systemPrompt would force a full replacement.
  assert.equal(result, undefined);
  assert.equal(sections[DYNAMAX_SECTION], DYNAMAX_REMINDER);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), "◆ dynamax · this turn");

  await agentEnd({ messages: [] }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});

test("Dynamax appends to a prompt an earlier extension forced, since pi renders no sections then", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  if (!input || !beforeAgentStart) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx } = createFakeContext("forced-prompt");

  await input({ source: "interactive", text: "dynamax review this" }, ctx);
  const result = await beforeAgentStart({ systemPrompt: "Forced.", systemPromptOptions: { sections: {}, forceSystemPrompt: "Forced." } }, ctx);

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
