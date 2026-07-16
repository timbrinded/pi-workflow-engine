import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, KeyId, TUI } from "@earendil-works/pi-tui";
import workflowEngine, {
  buildTemporaryWorkflowAuthorPrompt,
  getLastWorkflowInspection,
  inlineCompileErrorResult,
  normalizeWorkflowToolRequest,
} from "../.pi/extensions/pi-workflow-engine/index.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE } from "../.pi/extensions/pi-workflow-engine/src/dynamax.ts";
import {
  DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
  DEFAULT_REVIEW_RESULTS_SHORTCUT,
  type DynamaxShortcuts,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";
import { compileInlineWorkflow, InlineWorkflowCompileError } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { parallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

interface CapturedTool {
  name: string;
  readonly promptGuidelines?: readonly string[];
  execute(
    toolCallId: string,
    params: { script?: string; name?: string; args?: string; resumeFromRunId?: string },
    signal: AbortSignal | undefined,
    onUpdate: () => void,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface CapturedShortcut {
  key: KeyId;
  description?: string;
  handler(ctx: ExtensionContext): unknown | Promise<unknown>;
}

interface CapturedCommand {
  description?: string;
  handler(args: string, ctx: ExtensionCommandContext): unknown | Promise<unknown>;
}

interface CapturedWorkflowExtension {
  tool: CapturedTool;
  shortcuts: readonly CapturedShortcut[];
  commands: ReadonlyMap<string, CapturedCommand>;
}

/** Register the extension against a no-op `pi` and hand back its `workflow` tool. */
function captureWorkflowExtension(
  shortcuts: DynamaxShortcuts = {
    inspector: DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT,
    results: DEFAULT_REVIEW_RESULTS_SHORTCUT,
  },
): CapturedWorkflowExtension {
  let capturedTool: CapturedTool | undefined;
  const capturedShortcuts: CapturedShortcut[] = [];
  const capturedCommands = new Map<string, CapturedCommand>();
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
    sendMessage: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  workflowEngine(fakePi, shortcuts);
  if (!capturedTool) throw new Error("workflow tool was not registered");
  return { tool: capturedTool, shortcuts: capturedShortcuts, commands: capturedCommands };
}

function captureWorkflowTool(): CapturedTool {
  return captureWorkflowExtension().tool;
}

const HEADLESS_CTX = {
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: { find: () => undefined },
  sessionManager: createSessionManager("test-session"),
  hasUI: false,
  signal: undefined,
} as unknown as ExtensionContext;

function createTuiContext(customResult?: unknown, sessionId = "test-session"): {
  ctx: ExtensionContext;
  customCalls: () => number;
  customRenders: () => readonly string[][];
  notifications: () => readonly string[];
} {
  let customCallCount = 0;
  const customRenderLines: string[][] = [];
  const notificationMessages: string[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as ExtensionContext["ui"]["theme"];
  const tui = {
    terminal: { columns: 100, rows: 30 },
    requestRender: () => {},
  } as Pick<TUI, "terminal" | "requestRender">;
  const ctx = {
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: createSessionManager(sessionId),
    hasUI: true,
    mode: "tui",
    signal: undefined,
    ui: {
      theme,
      custom: async <T>(
        factory: (
          tuiArg: TUI,
          themeArg: ExtensionContext["ui"]["theme"],
          keybindings: never,
          done: (result: T) => void,
        ) => Component | Promise<Component>,
      ): Promise<T> => {
        customCallCount++;
        let completed: T | undefined;
        const component = await factory(tui as TUI, theme, undefined as never, (result) => {
          completed = result;
        });
        customRenderLines.push(component.render(100));
        return (customResult === undefined ? completed : customResult) as T;
      },
      setWidget: () => {},
      setStatus: () => {},
      notify: (message: string) => {
        notificationMessages.push(message);
      },
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    customCalls: () => customCallCount,
    customRenders: () => customRenderLines,
    notifications: () => notificationMessages,
  };
}

function createSessionManager(sessionId: string): Pick<ExtensionContext["sessionManager"], "getSessionFile" | "getSessionId"> {
  return {
    getSessionFile: () => undefined,
    getSessionId: () => sessionId,
  };
}

function resultUsageAssistantMessages(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const details = value.details;
  if (!isRecord(details)) return undefined;
  const usage = details.usage;
  if (!isRecord(usage)) return undefined;
  return usage.assistantMessages;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const RETAINED_REVIEW_RESULT = {
  summary: "Review complete.",
  findings: [{
    summary: "Retained finding.",
    category: "bug",
    severity: "high",
    confidence: "high",
    locations: [{ file: "src/app.ts", line: 10 }],
    evidence: ["line 10"],
    impact: "The result must remain reopenable.",
    recommendation: "Keep the validated report in session memory.",
  }],
  nextSteps: [],
} as const;

function codeReviewScript(description: string, result: unknown, preamble = ""): string {
  return `
export const meta = ${JSON.stringify({ name: "code-review", description })};
export default async function run() {
  ${preamble}
  return ${JSON.stringify(result)};
}
`;
}

function createFakeApi(overrides: Partial<WorkflowApi> = {}): WorkflowApi {
  const agent = (async (_prompt: string, opts?: AgentOptions) => (opts?.schema ? { ok: true } : "agent text")) as WorkflowApi["agent"];
  return {
    agent,
    workflow: async () => {
      throw new Error("sub-workflows are not enabled in this context");
    },
    parallel,
    pipeline,
    phase() {},
    log() {},
    progress() {},
    args: "",
    cwd: process.cwd(),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    signal: undefined,
    ...overrides,
  };
}

test("normalizeWorkflowToolRequest accepts named workflow requests", () => {
  assert.deepEqual(normalizeWorkflowToolRequest({ name: " code-review " }), { kind: "named", name: "code-review" });
});

test("temporary authoring, tool, and documentation guidance teach adaptive follow-up", () => {
  const temporaryPrompt = buildTemporaryWorkflowAuthorPrompt("investigate the parser");
  const toolGuidance = captureWorkflowTool().promptGuidelines?.join("\n");
  assert.ok(toolGuidance, "expected the registered workflow tool to provide prompt guidelines");
  const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");

  assert.ok(temporaryPrompt.includes(ADAPTIVE_WORKFLOW_GUIDANCE));
  assert.ok(toolGuidance.includes(ADAPTIVE_WORKFLOW_GUIDANCE));
  for (const text of [temporaryPrompt, toolGuidance, usage]) {
    assert.match(text, /first.pass/i);
    assert.match(text, /structured gap.analysis/i);
    assert.match(text, /follow.up/i);
    assert.match(text, /TypeScript/);
    assert.match(text, /sufficient/);
  }
});

test("the documented adaptive workflow bounds LLM-authored follow-up fan-out", async () => {
  const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");
  const example = /### Adaptive multi-pass authoring[\s\S]*?```ts\n([\s\S]*?)\n```/.exec(usage);
  assert.ok(example, "expected the adaptive TypeScript example in USAGE.md");

  const mod = compileInlineWorkflow(`
export const meta = { name: "documented-adaptive-bound", description: "Exercise the documented adaptive workflow" };
export default async function run(api) {
  const initialTasks = [() => Promise.resolve("first-pass result")];
${example[1]}
}
`);

  const proposedGaps = Array.from({ length: 10 }, (_, index) => ({
    question: `gap ${index + 1}`,
    reason: `reason ${index + 1}`,
  }));
  const followUpPrompts: string[] = [];
  let gapAnalysisCalls = 0;
  let synthesisCalls = 0;
  const agent = (async (prompt: string, options?: AgentOptions) => {
    if (options?.schema) {
      gapAnalysisCalls++;
      return { items: proposedGaps };
    }
    if (prompt.startsWith("Resolve this gap")) {
      followUpPrompts.push(prompt);
      return "resolved";
    }
    if (prompt.startsWith("Synthesize the first pass")) {
      synthesisCalls++;
      return "synthesized";
    }
    throw new Error(`unexpected agent prompt: ${prompt}`);
  }) as WorkflowApi["agent"];

  const result = await mod.default(createFakeApi({ agent }));

  assert.equal(gapAnalysisCalls, 1);
  assert.ok(followUpPrompts.length <= 4, `expected at most 4 follow-up calls, got ${followUpPrompts.length}`);
  assert.equal(followUpPrompts.length, 4);
  assert.equal(synthesisCalls, 1);
  assert.equal(result, "synthesized");
});

test("normalizeWorkflowToolRequest accepts inline workflow requests", () => {
  const script = 'export const meta = { name: "inline" };\nexport default async function run(api) { return "ok"; }';
  assert.deepEqual(normalizeWorkflowToolRequest({ script }), { kind: "inline", script });
});

test("normalizeWorkflowToolRequest rejects both or neither workflow target", () => {
  assert.equal(normalizeWorkflowToolRequest({ name: "code-review", script: "export const meta = {};" }).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({}).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({ name: "   ", script: "   " }).kind, "error");
});

test("inline workflow request compiles and runs without LLM calls", async () => {
  const script = `
export const meta = { name: "tool-inline", description: "Tool inline" };
export default async function run({ args, phase }) {
  phase("Inline");
  return { summary: args };
}
`;
  const request = normalizeWorkflowToolRequest({ script });
  assert.equal(request.kind, "inline");
  if (request.kind !== "inline") throw new Error("expected inline request");

  const phases: string[] = [];
  const mod = compileInlineWorkflow(request.script);
  const result = await mod.default(createFakeApi({ args: "from args", phase: (title) => phases.push(title) }));

  assert.equal(mod.meta.name, "tool-inline");
  assert.deepEqual(result, { summary: "from args" });
  assert.deepEqual(phases, ["Inline"]);
});

test("inline compile errors are shaped for workflow tool results", () => {
  let result = inlineCompileErrorResult("not compiled");
  try {
    compileInlineWorkflow("export const meta = makeMeta();");
  } catch (error) {
    if (!(error instanceof InlineWorkflowCompileError)) throw error;
    result = inlineCompileErrorResult(error.message);
  }

  assert.equal(result.details.error, "inline_compile_error");
  if (result.details.error !== "inline_compile_error") throw new Error("expected inline compile details");
  assert.match(result.details.message, /meta/);
  assert.match(result.content[0]?.text ?? "", /Inline workflow did not compile/);
});

test("workflow tool rejects blank resumeFromRunId", async () => {
  const tool = captureWorkflowTool();
  const script = `
export const meta = { name: "blank-resume", description: "Blank resume probe" };
export default async function run() {
  return "should not run";
}
`;

  const result = await tool.execute("call-blank-resume", { script, resumeFromRunId: "   " }, undefined, () => {}, HEADLESS_CTX);

  assert.ok(isRecord(result));
  const content = result.content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.text, "resumeFromRunId must be non-empty.");
  assert.deepEqual(result.details, { error: "invalid_resume_from_run_id" });
});

test("a tool-invoked workflow records an inspector snapshot", async () => {
  const tool = captureWorkflowTool();
  const script = `
export const meta = { name: "inspect-probe", description: "Inspector capture probe" };
export default async function run({ phase }) {
  phase("Solo");
  return { ok: true };
}
`;

  const result = await tool.execute("call-1", { script }, undefined, () => {}, HEADLESS_CTX);

  assert.equal(resultUsageAssistantMessages(result), 0);
  const inspection = getLastWorkflowInspection();
  assert.equal(inspection?.name, "inspect-probe");
  assert.ok(
    inspection?.snapshot.phases.some((phase) => phase.title === "Solo"),
    `expected a "Solo" phase in the captured snapshot, got ${JSON.stringify(inspection?.snapshot.phases.map((p) => p.title))}`,
  );
});

test("a TUI tool-invoked workflow opens the live inspector", async () => {
  const tool = captureWorkflowTool();
  const { ctx, customCalls } = createTuiContext();
  const script = `
export const meta = { name: "inspect-live-probe", description: "Live inspector probe" };
export default async function run({ phase }) {
  phase("Live");
  return { ok: true };
}
`;

  await tool.execute("call-2", { script }, undefined, () => {}, ctx);

  assert.equal(customCalls(), 1);
  const inspection = getLastWorkflowInspection();
  assert.equal(inspection?.name, "inspect-live-probe");
});

test("the results command and shortcut reopen the last code-review findings without rerunning it", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:results");
  const shortcut = extension.shortcuts.find((candidate) => candidate.description === "Open last code-review results");
  if (!command) throw new Error("expected /workflow:results command");
  if (!shortcut) throw new Error("expected code-review results shortcut");
  assert.equal(shortcut.key, DEFAULT_REVIEW_RESULTS_SHORTCUT);

  const runCounter = globalThis as typeof globalThis & { __piWorkflowResultsTestRuns?: number };
  runCounter.__piWorkflowResultsTestRuns = 0;
  const script = codeReviewScript(
    "Retained review result probe",
    RETAINED_REVIEW_RESULT,
    'globalThis["__piWorkflowResultsTestRuns"] = (globalThis["__piWorkflowResultsTestRuns"] ?? 0) + 1;',
  );
  try {
    await extension.tool.execute("call-results-retain", { script }, undefined, () => {}, HEADLESS_CTX);
    assert.equal(runCounter.__piWorkflowResultsTestRuns, 1);

    const tui = createTuiContext({ action: "fix", issueIds: ["R001"] });
    await command.handler("", tui.ctx as ExtensionCommandContext);
    assert.equal(tui.customCalls(), 1);
    assert.match(tui.customRenders()[0]?.join("\n") ?? "", /Review results/);
    assert.match(tui.customRenders()[0]?.join("\n") ?? "", /R001/);
    assert.match(tui.notifications().join("\n"), /Verifying the reviewed snapshot/);
    assert.equal(runCounter.__piWorkflowResultsTestRuns, 1);

    await shortcut.handler(tui.ctx);
    assert.equal(tui.customCalls(), 2);
    assert.equal(runCounter.__piWorkflowResultsTestRuns, 1);
  } finally {
    delete runCounter.__piWorkflowResultsTestRuns;
  }
});

test("an empty code review replaces stale retained findings", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:results");
  if (!command) throw new Error("expected /workflow:results command");
  const populatedScript = codeReviewScript("Populated review result probe", RETAINED_REVIEW_RESULT);
  const emptyScript = codeReviewScript("Empty review result probe", { summary: "No findings.", findings: [], nextSteps: [] });
  await extension.tool.execute("call-results-populated", { script: populatedScript }, undefined, () => {}, HEADLESS_CTX);
  await extension.tool.execute("call-results-empty", { script: emptyScript }, undefined, () => {}, HEADLESS_CTX);

  const tui = createTuiContext();
  await command.handler("", tui.ctx as ExtensionCommandContext);

  assert.equal(tui.customCalls(), 0);
  assert.equal(tui.notifications().at(-1), "The last code review had no findings");
});

test("a malformed code-review context clears the retained report instead of reopening stale findings", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:results");
  if (!command) throw new Error("expected /workflow:results command");
  const populatedScript = codeReviewScript("Populated context probe", RETAINED_REVIEW_RESULT);
  const malformedScript = codeReviewScript("Malformed context probe", {
    ...RETAINED_REVIEW_RESULT,
    reviewContext: { workflowName: "code-review", target: "PR", diffCommand: 123, files: ["src/app.ts"] },
  });
  await extension.tool.execute("call-results-valid-context", { script: populatedScript }, undefined, () => {}, HEADLESS_CTX);
  await extension.tool.execute("call-results-invalid-context", { script: malformedScript }, undefined, () => {}, HEADLESS_CTX);

  const tui = createTuiContext();
  await command.handler("", tui.ctx as ExtensionCommandContext);

  assert.equal(tui.customCalls(), 0);
  assert.equal(tui.notifications().at(-1), "No code-review result is available yet. Run /workflow code-review first.");
});

test("retained code-review results stay isolated to their originating session", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:results");
  if (!command) throw new Error("expected /workflow:results command");
  const sessionA = {
    ...HEADLESS_CTX,
    sessionManager: createSessionManager("session-a"),
  } as ExtensionContext;
  await extension.tool.execute(
    "call-results-session-a",
    { script: codeReviewScript("Session isolation probe", RETAINED_REVIEW_RESULT) },
    undefined,
    () => {},
    sessionA,
  );

  const sessionB = createTuiContext(undefined, "session-b");
  await command.handler("", sessionB.ctx as ExtensionCommandContext);
  assert.equal(sessionB.customCalls(), 0);
  assert.match(sessionB.notifications().at(-1) ?? "", /No code-review result is available/);

  const reopenedA = createTuiContext(undefined, "session-a");
  await command.handler("", reopenedA.ctx as ExtensionCommandContext);
  assert.equal(reopenedA.customCalls(), 1);
});

test("the inspector shortcut opens the active workflow inspector while the workflow tool is running", async () => {
  const { tool, shortcuts } = captureWorkflowExtension();
  const { ctx, customCalls, customRenders } = createTuiContext();
  const shortcut = shortcuts.find((candidate) => candidate.description === "Open workflow inspector");
  if (!shortcut) throw new Error("expected Dynamax inspector shortcut");
  const script = `
export const meta = { name: "inspect-live-shortcut-probe", description: "Live inspector shortcut probe" };
export default async function run({ phase }) {
  phase("Shortcut Live");
  await new Promise((resolve) => setTimeout(resolve, 75));
  return { ok: true };
}
`;

  const running = tool.execute("call-3", { script }, undefined, () => {}, ctx);
  await waitUntil(() => customCalls() >= 1, "initial live inspector");

  await shortcut.handler(ctx);

  assert.equal(customCalls(), 2);
  assert.match(customRenders().at(-1)?.join("\n") ?? "", /inspect-live-shortcut-probe/);
  await running;
});
