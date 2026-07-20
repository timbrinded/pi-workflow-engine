import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { resolve } from "node:path";
import {
  DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  resolveDynamaxShortcuts,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";
import {
  ADAPTIVE_WORKFLOW_GUIDANCE,
  appendDynamaxContextReminder,
  appendDynamaxSystemReminder,
  clearDynamax,
  createDynamaxRuntime,
  createDynamaxState,
  DYNAMAX_REMINDER,
  DYNAMAX_STATUS_KEY,
  type DynamaxRuntimeStore,
  dynamaxWidgetLine,
  enableDynamaxSticky,
  getDynamaxRuntime,
  hasDynamaxToken,
  highlightDynamaxTokens,
  isDynamaxActive,
  markDynamaxOneShot,
  registerDynamax,
  updateDynamaxSurfaces,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax.ts";
import { sessionKey } from "../.pi/extensions/pi-workflow-engine/src/session-identity.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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
  editorFactory: EditorFactory | undefined;
  editor: EditorComponent | undefined;
  customComponent: Component | undefined;
}

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type EditorKeybindings = Parameters<EditorFactory>[2];

function captureDynamax(
  shortcut: KeyId | null = DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  openInspector?: (ctx: ExtensionContext) => void | Promise<void>,
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

  registerDynamax(fakePi, { inspector: shortcut, results: null }, { openInspector });
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
    editorFactory: initialEditorFactory,
    editor: undefined,
    customComponent: undefined,
  };
  const tui = {
    terminal: { columns: 80, rows: 24 },
    requestRender: () => {},
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

test("Dynamax highlights only standalone tokens", () => {
  const prompt = "dynamax notdynamax dynamaxing dynamax_mode (DYNAMAX)";
  const highlighted = highlightDynamaxTokens(prompt);
  const colorStarts = highlighted.match(/\x1b\[38;2;/g) ?? [];

  assert.equal(colorStarts.length, "dynamaxDYNAMAX".length);
  assert.equal(highlighted.replace(/\x1b\[[0-9;]*m/g, ""), prompt);
  assert.equal(highlightDynamaxTokens("notdynamax dynamaxing dynamax_mode"), "notdynamax dynamaxing dynamax_mode");

  const cursorInsideToken = "\x1b[31mdyna\x1b_pi:c\x07\x1b[7mm\x1b[0max";
  const highlightedCursorLine = highlightDynamaxTokens(cursorInsideToken);
  assert.equal(highlightedCursorLine.match(/\x1b\[38;2;/g)?.length, "dynamax".length);

  const styledSuffix = highlightDynamaxTokens("\x1b[31mdynamax suffix\x1b[0m");
  assert.match(styledSuffix, /\x1b\[31m suffix/);
  assert.doesNotMatch(styledSuffix, /\x1b\[39m suffix/);
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

test("Dynamax does not overwrite a later editor replacement on shutdown", async () => {
  const captured = captureDynamax();
  const sessionStart = captured.handlers.get("session_start")?.[0];
  const sessionShutdown = captured.handlers.get("session_shutdown")?.[0];
  if (!sessionStart || !sessionShutdown) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await sessionStart({}, ctx);
  const lateFactory: EditorFactory = () => createStubEditor();
  ctx.ui.setEditorComponent(lateFactory);
  assert.equal(ui.editorFactory, lateFactory);

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

test("dynamax one-shot state is consumed by system reminder", () => {
  const state = createDynamaxState();
  markDynamaxOneShot(state);

  const prompted = appendDynamaxSystemReminder("base", state);

  assert.match(prompted, /dynamax workflow opt-in/);
  assert.equal(state.oneShotPending, false);
  assert.equal(appendDynamaxSystemReminder("base", state), "base");
});

test("dynamax reminder teaches optional adaptive multi-pass workflows", () => {
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /simple single-pass fan-out/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /structured gap-analysis agent/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /ordinary TypeScript conditionals or bounded loops/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /only when gaps exist/);
  assert.match(ADAPTIVE_WORKFLOW_GUIDANCE, /Do not generate a second pass when the first pass is sufficient/);
  assert.ok(DYNAMAX_REMINDER.includes(ADAPTIVE_WORKFLOW_GUIDANCE));
  assert.match(DYNAMAX_REMINDER, /profile to "small", "medium", or "big"/);
});

test("dynamax sticky mode remains active until cleared", () => {
  const state = createDynamaxState();
  enableDynamaxSticky(state);

  assert.equal(isDynamaxActive(state), true);
  assert.match(appendDynamaxSystemReminder("base", state), /workflow tool is permitted/);
  assert.equal(state.sticky, true);
  assert.equal(isDynamaxActive(state), true);

  clearDynamax(state);
  assert.equal(isDynamaxActive(state), false);
});

test("appendDynamaxContextReminder appends a hidden custom message only when sticky", () => {
  const state = createDynamaxState();
  const messages: AgentMessage[] = [];

  assert.equal(appendDynamaxContextReminder(messages, state), messages);

  enableDynamaxSticky(state);
  const appended = appendDynamaxContextReminder(messages, state);
  assert.equal(appended.length, 1);
  const reminder = appended[0];
  assert.equal(isRecord(reminder) ? reminder.role : undefined, "custom");
  assert.equal(isRecord(reminder) ? reminder.customType : undefined, "workflow-dynamax-reminder");
  assert.equal(isRecord(reminder) ? reminder.display : undefined, false);
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

  assert.match(first.ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /sticky on/);
  assert.equal(second.ui.notifications.at(-1)?.message, "Dynamax sticky off; one-shot clear");
});

test("dynamax widget helper describes sticky and one-shot state", () => {
  const runtime = createDynamaxRuntime();
  enableDynamaxSticky(runtime.state);
  markDynamaxOneShot(runtime.state);

  assert.match(dynamaxWidgetLine(runtime.state, "ctrl+shift+x", "inline workflow"), /running inline workflow \+ sticky on \+ one-shot pending/);
  assert.match(dynamaxWidgetLine(runtime.state, "ctrl+shift+x"), /\/workflow:dynamax on\|off/);
  assert.match(dynamaxWidgetLine(runtime.state, "ctrl+shift+x"), /ctrl\+shift\+x inspector/);
  assert.doesNotMatch(dynamaxWidgetLine(runtime.state, "ctrl+shift+x"), /panel/);
});

test("one-shot Dynamax status remains visible for the active turn", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  const agentEnd = captured.handlers.get("agent_end")?.[0];
  if (!input || !beforeAgentStart || !agentEnd) throw new Error("expected Dynamax lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await input({ source: "interactive", text: "dynamax inspect this branch" }, ctx);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /one-shot pending/);

  const result = await beforeAgentStart({ systemPrompt: "base" }, ctx);
  assert.match(isRecord(result) && typeof result.systemPrompt === "string" ? result.systemPrompt : "", /dynamax workflow opt-in/);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /active this turn/);

  await agentEnd({ messages: [] }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});

test("one-shot Dynamax status survives ordinary host tool calls without refresh handlers", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const input = captured.handlers.get("input")?.[0];
  const beforeAgentStart = captured.handlers.get("before_agent_start")?.[0];
  const toolStart = captured.handlers.get("tool_execution_start")?.[0];
  const toolEnd = captured.handlers.get("tool_execution_end")?.[0];
  const agentEnd = captured.handlers.get("agent_end")?.[0];
  if (!input || !beforeAgentStart || !toolStart || !toolEnd || !agentEnd) {
    throw new Error("expected Dynamax lifecycle handlers");
  }
  const { ctx, ui } = createFakeContext("session-a");

  await input({ source: "interactive", text: "dynamax inspect this branch" }, ctx);
  await beforeAgentStart({ systemPrompt: "base" }, ctx);

  await toolStart({ toolName: "read", args: { path: ".pi/extensions/pi-workflow-engine/workflows/code-review.ts" } }, ctx);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /active this turn/);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /\/workflow:dynamax on\|off/);

  await toolEnd({ toolName: "read" }, ctx);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /active this turn/);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /ctrl\+shift\+x inspector/);

  await agentEnd({ messages: [] }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});

test("workflow tool lifecycle updates the Dynamax running label", async () => {
  const captured = captureDynamax("ctrl+shift+x");
  const start = captured.handlers.get("tool_execution_start")?.[0];
  const end = captured.handlers.get("tool_execution_end")?.[0];
  if (!start || !end) throw new Error("expected workflow tool lifecycle handlers");
  const { ctx, ui } = createFakeContext("session-a");

  await start({ toolName: "workflow", args: { name: "code-review" } }, ctx);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /running code-review/);
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /ctrl\+shift\+x inspector/);

  await end({ toolName: "workflow" }, ctx);
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});

test("updateDynamaxSurfaces clears inactive UI", () => {
  const runtime = createDynamaxRuntime();
  const { ctx, ui } = createFakeContext("session-a");

  enableDynamaxSticky(runtime.state);
  updateDynamaxSurfaces(ctx, runtime, { inspector: "ctrl+shift+x", results: null });
  assert.match(ui.statuses.get(DYNAMAX_STATUS_KEY) ?? "", /sticky on/);

  clearDynamax(runtime.state);
  updateDynamaxSurfaces(ctx, runtime, { inspector: "ctrl+shift+x", results: null });
  assert.equal(ui.statuses.get(DYNAMAX_STATUS_KEY), undefined);
});
