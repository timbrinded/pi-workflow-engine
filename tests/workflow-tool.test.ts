import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import workflowEngine, {
  buildTemporaryWorkflowAuthorPrompt,
  getLastWorkflowInspection,
  inlineCompileErrorResult,
  normalizeWorkflowToolRequest,
  WORKFLOW_TOOL_PROMPT_GUIDELINES,
} from "../.pi/extensions/pi-workflow-engine/index.ts";
import { ADAPTIVE_WORKFLOW_GUIDANCE } from "../.pi/extensions/pi-workflow-engine/src/dynamax.ts";
import { compileInlineWorkflow, InlineWorkflowCompileError } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { parallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

interface CapturedTool {
  name: string;
  execute(
    toolCallId: string,
    params: { script?: string; name?: string; args?: string; resumeFromRunId?: string },
    signal: AbortSignal | undefined,
    onUpdate: () => void,
    ctx: ExtensionContext,
  ): Promise<unknown>;
}

interface CapturedShortcut {
  description?: string;
  handler(ctx: ExtensionContext): unknown | Promise<unknown>;
}

interface CapturedWorkflowExtension {
  tool: CapturedTool;
  shortcut: CapturedShortcut | undefined;
}

/** Register the extension against a no-op `pi` and hand back its `workflow` tool. */
function captureWorkflowExtension(): CapturedWorkflowExtension {
  let capturedTool: CapturedTool | undefined;
  let capturedShortcut: CapturedShortcut | undefined;
  const fakePi = {
    on: () => {},
    registerCommand: () => {},
    registerShortcut: (_key: string, shortcut: CapturedShortcut) => {
      capturedShortcut = shortcut;
    },
    registerMessageRenderer: () => {},
    registerTool: (tool: unknown) => {
      const candidate = tool as CapturedTool;
      if (candidate.name === "workflow") capturedTool = candidate;
    },
    sendMessage: () => {},
    sendUserMessage: () => {},
  } as unknown as ExtensionAPI;
  workflowEngine(fakePi);
  if (!capturedTool) throw new Error("workflow tool was not registered");
  return { tool: capturedTool, shortcut: capturedShortcut };
}

function captureWorkflowTool(): CapturedTool {
  return captureWorkflowExtension().tool;
}

const HEADLESS_CTX = {
  cwd: process.cwd(),
  model: undefined,
  modelRegistry: { find: () => undefined },
  hasUI: false,
  signal: undefined,
} as unknown as ExtensionContext;

function createTuiContext(): { ctx: ExtensionContext; customCalls: () => number; customRenders: () => readonly string[][] } {
  let customCallCount = 0;
  const customRenderLines: string[][] = [];
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
    hasUI: true,
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
        return completed as T;
      },
      setWidget: () => {},
      setStatus: () => {},
    },
  } as unknown as ExtensionContext;
  return { ctx, customCalls: () => customCallCount, customRenders: () => customRenderLines };
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
  const toolGuidance = WORKFLOW_TOOL_PROMPT_GUIDELINES.join("\n");
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

test("the inspector shortcut opens the active workflow inspector while the workflow tool is running", async () => {
  const { tool, shortcut } = captureWorkflowExtension();
  const { ctx, customCalls, customRenders } = createTuiContext();
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
