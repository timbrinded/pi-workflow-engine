import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import {
  buildTemporaryWorkflowAuthorPrompt,
  inlineCompileErrorResult,
  openWorkflowInspector,
} from "../.pi/extensions/pi-workflow-engine/index.ts";
import { normalizeWorkflowToolRequest } from "../.pi/extensions/pi-workflow-engine/src/workflow-tool-request.ts";
import { DEFAULT_REVIEW_RESULTS_SHORTCUT } from "../.pi/extensions/pi-workflow-engine/src/dynamax-shortcuts.ts";
import { isRecord } from "../.pi/extensions/pi-workflow-engine/src/guards.ts";
import { compileInlineWorkflow, InlineWorkflowCompileError } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { parallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { ProjectWorkflowRunStore } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import { MAX_WORKFLOW_SCRIPT_FILE_BYTES } from "../.pi/extensions/pi-workflow-engine/src/workflow-script-file.ts";
import { WORKFLOW_INSPECTOR_OVERLAY_OPTIONS } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-inspector.ts";
import { captureWorkflowExtension, captureWorkflowTool } from "./workflow-extension-fixtures.ts";
import { createTestTheme } from "./fixtures/theme.ts";

const WORKFLOW_TOOL_TEST_CWD = mkdtempSync(join(tmpdir(), "pi-workflow-tool-tests-"));
process.on("exit", () => rmSync(WORKFLOW_TOOL_TEST_CWD, { recursive: true, force: true }));

const HEADLESS_CTX = {
  cwd: WORKFLOW_TOOL_TEST_CWD,
  isProjectTrusted: () => true,
  model: undefined,
  modelRegistry: { find: () => undefined },
  sessionManager: createSessionManager("test-session"),
  hasUI: false,
  signal: undefined,
} as unknown as ExtensionContext;

function createTuiContext(customResult?: unknown, sessionId = "test-session"): {
  ctx: ExtensionContext;
  customCalls: () => number;
  customOptions: () => readonly unknown[];
  customRenders: () => readonly string[][];
  notifications: () => readonly string[];
} {
  let customCallCount = 0;
  const customOptionValues: unknown[] = [];
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
    cwd: WORKFLOW_TOOL_TEST_CWD,
    isProjectTrusted: () => true,
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
        options?: unknown,
      ): Promise<T> => {
        customCallCount++;
        customOptionValues.push(options);
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
    customOptions: () => customOptionValues,
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

function toolResultText(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return "";
  const first: unknown = value.content[0];
  return isRecord(first) && typeof first.text === "string" ? first.text : "";
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
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
    classify: async () => {
      throw new Error("no classifier is configured in this test");
    },
    workflow: async () => {
      throw new Error("sub-workflows are not enabled in this context");
    },
    parallel,
    pipeline,
    phase() {},
    log() {},
    progress() {},
    args: "",
    input: "",
    cwd: process.cwd(),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    signal: undefined,
    ...overrides,
  };
}

test("normalizeWorkflowToolRequest accepts named workflow requests", () => {
  assert.deepEqual(normalizeWorkflowToolRequest({ name: " code-review " }), { kind: "named", name: "code-review" });
});

test("/workflow exposes native workflow-name and option completions", async () => {
  const completions = captureWorkflowExtension().commands.get("workflow")?.getArgumentCompletions;
  assert.ok(completions);
  const workflows = await completions("code");
  assert.ok(workflows?.some((item) => item.value === "code-review" && item.description));

  const options = await completions("code-review --re");
  assert.deepEqual(
    options?.slice(0, 4).map((item) => item.value),
    ["code-review --refresh", "code-review --result-viewer", "code-review --resume-edited", "code-review --resume="],
  );
  assert.ok(options?.some((item) => item.value === "code-review --agent-retries="));
});

test("RPC command and inspector surfaces use native selection and text instead of custom components", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow");
  assert.ok(command);
  const notifications: string[] = [];
  let selectCalls = 0;
  let customCalls = 0;
  const ctx = {
    cwd: WORKFLOW_TOOL_TEST_CWD,
    isProjectTrusted: () => true,
    mode: "rpc",
    hasUI: true,
    model: undefined,
    modelRegistry: { find: () => undefined },
    sessionManager: createSessionManager("rpc-ui-routing"),
    signal: undefined,
    ui: {
      theme: createTuiContext().ctx.ui.theme,
      select: async () => {
        selectCalls++;
        return undefined;
      },
      custom: async () => {
        customCalls++;
        throw new Error("RPC must not open custom components");
      },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;

  await command.handler("", ctx);
  assert.equal(selectCalls, 1);
  assert.equal(customCalls, 0);
  assert.deepEqual(notifications, [], "dismissing the picker is a cancel, not a usage error");

  const inspection = {
    name: "rpc-inspection",
    args: "",
    completedAt: Date.now(),
    snapshot: {
      runId: "rpc-inspection-run",
      title: "rpc-inspection",
      startedAt: Date.now() - 10,
      doneAt: Date.now(),
      currentPhase: "Complete",
      phases: [],
      counters: [],
      summary: [],
      lanes: [],
      laneOverflow: [],
      logs: ["completed"],
    },
  };
  await openWorkflowInspector(ctx, inspection);
  assert.equal(customCalls, 0);
  assert.match(notifications.at(-1) ?? "", /Workflow inspector: rpc-inspection/);
});

function authoringSkillPath(): string {
  const toolGuidance = captureWorkflowTool().promptGuidelines?.join("\n") ?? "";
  const path = /read the workflow-authoring skill \(([^)]+)\)/.exec(toolGuidance)?.[1];
  assert.ok(path, "expected the workflow tool guidelines to name the workflow-authoring skill path");
  return path;
}

test("the authoring skill and usage guide teach adaptive follow-up; the tool and authoring prompt point to the skill", () => {
  const temporaryPrompt = buildTemporaryWorkflowAuthorPrompt("investigate the parser");
  const skill = readFileSync(authoringSkillPath(), "utf8");
  const usage = readFileSync(new URL("../USAGE.md", import.meta.url), "utf8");

  assert.match(temporaryPrompt, /read the workflow-authoring skill/);
  for (const text of [skill, usage]) {
    assert.match(text, /first.pass/i);
    assert.match(text, /structured gap.analysis/i);
    assert.match(text, /follow.up/i);
    assert.match(text, /sufficient/);
  }
});

test("every authoring-skill example compiles as inline workflow code", () => {
  const skill = readFileSync(authoringSkillPath(), "utf8");
  const examples = [...skill.matchAll(/```js\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
  assert.ok(examples.length >= 4, `expected several skill examples, found ${examples.length}`);
  for (const example of examples) {
    // Full scripts compile as they are; fragments compile as the body of a default export.
    const script = example.startsWith("export const meta")
      ? example
      : `export const meta = { name: "skill-example" };\nexport default async function run(api) {\n${example}\n}`;
    assert.doesNotThrow(() => compileInlineWorkflow(script), `skill example did not compile:\n${example}`);
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

test("normalizeWorkflowToolRequest accepts a script file path", () => {
  assert.deepEqual(normalizeWorkflowToolRequest({ scriptPath: " scripts/run.js " }), { kind: "script-path", scriptPath: "scripts/run.js" });
});

test("normalizeWorkflowToolRequest rejects more or fewer than one workflow target", () => {
  assert.equal(normalizeWorkflowToolRequest({ name: "code-review", script: "export const meta = {};" }).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({ script: "export const meta = {};", scriptPath: "run.js" }).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({ name: "code-review", scriptPath: "run.js" }).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({}).kind, "error");
  assert.equal(normalizeWorkflowToolRequest({ name: "   ", script: "   ", scriptPath: " " }).kind, "error");
});

test("an inline run names its persisted script and journal, and reruns from the edited script by scriptPath", async () => {
  const tool = captureWorkflowTool();
  const script = (value: string) => `export const meta = { name: "iterate-probe", description: "Iterate probe" };
export default async function run() { return { summary: "${value}" }; }`;

  const first = await tool.execute("call-iterate-first", { script: script("first pass") }, undefined, () => {}, HEADLESS_CTX);
  assert.ok(isRecord(first) && isRecord(first.details));
  const runId = first.details.runId;
  if (typeof runId !== "string") throw new Error("expected a run id");
  const scriptPath = `.pi/.workflow-runs/${runId}.script.js`;
  const text = toolResultText(first);
  assert.match(text, new RegExp(`Script: ${scriptPath.replaceAll(".", "\\.")}`));
  assert.match(text, new RegExp(`Journal: \\.pi/\\.workflow-runs/${runId}\\.jsonl`));
  assert.match(text, /If the result is empty or unexpected, read the journal before diagnosing\./);
  assert.equal(readFileSync(join(WORKFLOW_TOOL_TEST_CWD, scriptPath), "utf8"), script("first pass"));
  assert.equal(readFileSync(join(WORKFLOW_TOOL_TEST_CWD, ".pi/.workflow-runs/.gitignore"), "utf8"), "*\n");

  writeFileSync(join(WORKFLOW_TOOL_TEST_CWD, scriptPath), script("edited pass"));
  const rerun = await tool.execute("call-iterate-rerun", { scriptPath, resumeFromRunId: runId }, undefined, () => {}, HEADLESS_CTX);
  assert.ok(isRecord(rerun) && isRecord(rerun.details));
  assert.match(toolResultText(rerun), /edited pass/);
  assert.equal(rerun.details.resumedFromRunId, runId);
  const rerunId = rerun.details.runId;
  if (typeof rerunId !== "string") throw new Error("expected a rerun id");
  const record = await new ProjectWorkflowRunStore(WORKFLOW_TOOL_TEST_CWD).load(rerunId);
  assert.equal(record?.options.resumeEditedWorkflow, true, "scriptPath with resumeFromRunId implies edited-workflow resume");
  assert.equal(record?.scriptFile, `${rerunId}.script.js`);
});

test("JSON tool args reach the workflow verbatim and as text, and count as redacted arguments", async () => {
  const tool = captureWorkflowTool();
  const script = `export const meta = { name: "json-args-probe", description: "JSON args probe" };
export default async function run({ args, input }) { return { summary: args, kind: Array.isArray(input) ? "array" : typeof input }; }`;
  const store = new ProjectWorkflowRunStore(WORKFLOW_TOOL_TEST_CWD);
  const run = async (args: unknown) => {
    const result = await tool.execute("call-json-args", args === undefined ? { script } : { script, args }, undefined, () => {}, HEADLESS_CTX);
    assert.ok(isRecord(result) && isRecord(result.details) && typeof result.details.runId === "string");
    return { details: result.details, record: await store.load(result.details.runId) };
  };

  const json = await run({ files: ["a.ts"], strict: true });
  assert.deepEqual(json.details.result, { summary: '{"files":["a.ts"],"strict":true}', kind: "object" });
  assert.equal(json.record?.options.argumentsPresent, true);

  assert.deepEqual((await run(["x"])).details.result, { summary: '["x"]', kind: "array" });
  assert.deepEqual((await run("plain text")).details.result, { summary: "plain text", kind: "string" });
  const omitted = await run(undefined);
  assert.deepEqual(omitted.details.result, { summary: "", kind: "string" });
  assert.equal(omitted.record?.options.argumentsPresent, false);
});

test("a scriptPath must name a bounded regular file, so a FIFO or a huge file is a rejected call", async () => {
  const dir = join(WORKFLOW_TOOL_TEST_CWD, "script-file-kinds");
  mkdirSync(dir, { recursive: true });
  const tool = captureWorkflowTool();
  const run = async (scriptPath: string) => {
    const result = await tool.execute("call-script-file-kind", { scriptPath }, undefined, () => {}, HEADLESS_CTX);
    assert.ok(isRecord(result) && isRecord(result.details));
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "invalid_script_path");
    return toolResultText(result);
  };
  try {
    const valid = 'export const meta = { name: "huge-probe", description: "" };\nexport default async function run() { return 1; }\n';
    writeFileSync(join(dir, "huge.js"), `${valid}//${"x".repeat(MAX_WORKFLOW_SCRIPT_FILE_BYTES)}\n`);
    assert.match(await run("script-file-kinds/huge.js"), /over the 1048576-byte limit/);

    // With no writer, reading a FIFO would never return.
    if (spawnSync("mkfifo", [join(dir, "pipe.js")]).status === 0) {
      assert.match(await run("script-file-kinds/pipe.js"), /is not a regular file/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed inline run names its script and journal for the next attempt", async () => {
  const script = `export const meta = { name: "failing-iterate", description: "Failing iterate probe" };
export default async function run() { throw new Error("broken step"); }`;
  const failed = await captureWorkflowTool().execute("call-failing-iterate", { script }, undefined, () => {}, HEADLESS_CTX);

  const text = toolResultText(failed);
  assert.match(text, /Workflow failing-iterate failed: broken step\n\nRun: \S+\nScript: \.pi\/\.workflow-runs\/\S+\.script\.js\nJournal: /);
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

test("the workflow tool shows the host agent result fields beyond the summary", async () => {
  const tool = captureWorkflowTool();
  const run = async (name: string, result: string): Promise<string> => {
    const script = `export const meta = { name: "${name}", description: "Result content probe" };
export default async function run() { return ${result}; }`;
    return toolResultText(await tool.execute(`call-${name}`, { script }, undefined, () => {}, HEADLESS_CTX));
  };

  const report = await run("research-shaped", `{ answer: "THE-ANSWER", sources: [{ url: "https://example.test/source" }] }`);
  assert.match(report, /THE-ANSWER/);
  assert.match(report, /https:\/\/example\.test\/source/);
  assert.doesNotMatch(report, /Workflow finished\./);

  const patch = await run("summary-and-patch", `{ summary: "Patch ready.", patch: "diff --git a/x b/x" }`);
  assert.match(patch, /Patch ready\.\n\nResult:/);
  assert.match(patch, /diff --git a\/x b\/x/);

  const summaryOnly = await run("summary-only", `{ summary: "Just the summary." }`);
  assert.match(summaryOnly, /Just the summary\./);
  assert.doesNotMatch(summaryOnly, /Result/);

  const oversized = await run("oversized", `{ blob: "x".repeat(50000) }`);
  assert.match(oversized, /truncated/);
  assert.ok(oversized.length < 25_000, `expected a bounded result, got ${oversized.length} characters`);
});

test("the workflow tool gives the host agent the viewer's finding id, review anchor and coverage gaps", async () => {
  const tool = captureWorkflowTool();
  const finding = {
    summary: "Anchored finding.", category: "bug", severity: "high", confidence: "high",
    locations: [{ file: "src/caller.ts", line: 90 }], reviewAnchor: { file: "src/app.ts", line: 12 },
    evidence: ["line 12"], impact: "Breaks callers.", recommendation: "Fix the changed line.",
  };
  const script = `export const meta = { name: "anchored-review", description: "Anchor probe" };
export default async function run() { return ${JSON.stringify({ summary: "Review incomplete.", findings: [finding], nextSteps: [], status: "incomplete", gaps: ["verify/correctness: provider timeout"] })}; }`;

  const text = toolResultText(await tool.execute("call-anchored-review", { script }, undefined, () => {}, HEADLESS_CTX));

  assert.match(text, /### R001: Anchored finding\./);
  assert.match(text, /- Location: src\/app\.ts:12, src\/caller\.ts:90/);
  assert.match(text, /Coverage gaps:\n- verify\/correctness: provider timeout/);
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
  assert.equal(result.isError, true);
});

test("the workflow tool's guidelines carry the profile rule the Dynamax reminder no longer repeats", () => {
  assert.match(captureWorkflowTool().promptGuidelines?.join("\n") ?? "", /profile: \\?"small\\?".*every `api\.agent\(\)` call/);
});

test("the workflow tool is a model-only orchestrator that codemode scripts cannot start", () => {
  assert.equal(captureWorkflowTool().exposure, "model-only");
});

test("a +N prompt directive defaults the run budget to the turn pool until the run settles", async () => {
  const extension = captureWorkflowExtension();
  const input = extension.handlers.get("input")?.[0];
  if (!input) throw new Error("expected an input handler");
  const ctx = { ...HEADLESS_CTX, sessionManager: createSessionManager("turn-budget-tool") } as ExtensionContext;
  const emit = async (event: string, payload: unknown) => {
    for (const handler of extension.handlers.get(event) ?? []) await handler(payload, ctx);
  };
  const script = `
export const meta = { name: "turn-budget-probe", description: "Reports its budget" };
export default async function run({ budget }) {
  return { summary: \`budget \${budget.total}\` };
}
`;
  const budgetOf = async (params: { budget?: number } = {}) =>
    toolResultText(await extension.tool.execute("call-turn-budget", { script, ...params }, undefined, () => {}, ctx));

  await input({ source: "interactive", text: "+5k run the probe" }, ctx);
  assert.match(await budgetOf(), /budget 5000/);
  assert.match(await budgetOf({ budget: 1234 }), /budget 1234/);
  // A provider retry or overflow compaction ends a loop with agent_end and continues the same run.
  await emit("agent_end", { type: "agent_end", messages: [] });
  assert.match(await budgetOf(), /budget 5000/);
  await emit("agent_settled", { type: "agent_settled", aborted: false });
  assert.match(await budgetOf(), /budget null/);
});

test("workflow tool marks an unknown workflow as a failed call", async () => {
  const result = await captureWorkflowTool().execute("call-unknown", { name: "does-not-exist" }, undefined, () => {}, HEADLESS_CTX);

  assert.ok(isRecord(result));
  assert.equal(result.isError, true);
  assert.ok(isRecord(result.details));
  assert.equal(result.details.error, "unknown_workflow");
});

test("a project's saved script runs by name only while pi trusts the project", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-tool-project-"));
  try {
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "workflows", "project-probe.js"),
      'export const meta = { name: "project-probe", description: "Project probe" };\nexport default async function run() { return { summary: "project script ran" }; }\n',
    );
    const tool = captureWorkflowTool();

    const untrusted = await tool.execute("call-project-untrusted", { name: "project-probe" }, undefined, () => {}, { ...HEADLESS_CTX, cwd, isProjectTrusted: () => false });
    assert.ok(isRecord(untrusted) && isRecord(untrusted.details));
    assert.equal(untrusted.details.error, "unknown_workflow");

    const trusted = await tool.execute("call-project-trusted", { name: "project-probe" }, undefined, () => {}, { ...HEADLESS_CTX, cwd });
    assert.match(toolResultText(trusted), /project script ran/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
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
  assert.equal(result.isError, true);
});

test("workflow tool requires a prior run for edited-source reuse", async () => {
  const tool = captureWorkflowTool();
  const result = await tool.execute(
    "call-edited-resume",
    { script: "export const meta = { name: 'edited', description: 'edited' }; export default async function () { return 'no'; }", resumeEditedWorkflow: true },
    undefined,
    () => {},
    HEADLESS_CTX,
  );

  assert.ok(isRecord(result));
  const content = result.content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0]?.text, "resumeEditedWorkflow requires resumeFromRunId.");
  assert.deepEqual(result.details, { error: "invalid_edited_workflow_resume" });
  assert.equal(result.isError, true);
});

test("workflow tool rejects background mode in finite print execution", async () => {
  const tool = captureWorkflowTool();
  const ctx = { ...HEADLESS_CTX, mode: "print" } as ExtensionContext;
  const result = await tool.execute(
    "call-background-print",
    { script: "export const meta = { name: 'print', description: 'print' }; export default async function () { return 'no'; }", background: true },
    undefined,
    () => {},
    ctx,
  );

  assert.ok(isRecord(result));
  assert.deepEqual(result.details, { error: "background_unavailable", mode: "print" });
  assert.equal(result.isError, true);
});

test("workflow tool returns a durable background run id and detaches from the initiating tool signal", async () => {
  const extension = captureWorkflowExtension();
  const branch: unknown[] = [];
  const ctx = {
    ...HEADLESS_CTX,
    mode: "rpc",
    isIdle: () => true,
    sessionManager: {
      ...createSessionManager("background-tool-session"),
      getBranch: () => branch,
      getEntries: () => branch,
    },
  } as unknown as ExtensionContext;
  const initiatingTurn = new AbortController();
  initiatingTurn.abort(new Error("initiating turn ended"));
  const script = `
export const meta = { name: "background-tool", description: "Background tool probe" };
export default async function run() {
  return { summary: "Detached background completed." };
}
`;

  const result = await extension.tool.execute(
    "call-background-tool",
    { script, background: true },
    initiatingTurn.signal,
    () => {},
    ctx,
  );
  assert.ok(isRecord(result) && isRecord(result.details));
  assert.equal(result.details.background, true);
  assert.equal(result.details.state, "running");
  const runId = result.details.runId;
  assert.equal(typeof runId, "string");
  if (typeof runId !== "string") throw new Error("expected background run id");
  assert.match(toolResultText(result), new RegExp(`\\nScript: \\.pi/\\.workflow-runs/${runId}\\.script\\.js$`));

  const store = new ProjectWorkflowRunStore(WORKFLOW_TOOL_TEST_CWD);
  await waitUntil(
    async () => (await store.load(runId))?.background?.delivery.state === "delivered",
    "durable background delivery",
  );
  const record = await store.load(runId);
  assert.equal(record?.state, "completed");
  assert.equal(record?.background?.delivery.state, "delivered");
  assert.match(JSON.stringify(extension.sentMessages[0]), /Detached background completed/);
});

test("a background run started while Dynamax is active wakes the agent when it completes", async () => {
  const extension = captureWorkflowExtension();
  const input = extension.handlers.get("input")?.[0];
  if (!input) throw new Error("expected the Dynamax input handler");
  const branch: unknown[] = [];
  const ctx = {
    ...HEADLESS_CTX,
    mode: "rpc",
    isIdle: () => true,
    sessionManager: {
      ...createSessionManager("background-wake-tool-session"),
      getBranch: () => branch,
      getEntries: () => branch,
    },
  } as unknown as ExtensionContext;
  const script = `
export const meta = { name: "background-wake-tool", description: "Background wake probe" };
export default async function run() {
  return { summary: "Woke the agent." };
}
`;
  const store = new ProjectWorkflowRunStore(WORKFLOW_TOOL_TEST_CWD);
  const startRun = async (): Promise<string> => {
    const result = await extension.tool.execute("call-background-wake", { script, background: true }, undefined, () => {}, ctx);
    const runId = isRecord(result) && isRecord(result.details) ? result.details.runId : undefined;
    if (typeof runId !== "string") throw new Error("expected background run id");
    await waitUntil(async () => (await store.load(runId))?.background?.delivery.state === "delivered", "background delivery");
    return runId;
  };
  const deliveryOptions = (runId: string): unknown =>
    extension.sentMessageOptions[extension.sentMessages.findIndex((message) => JSON.stringify(message).includes(runId))];

  const silent = await startRun();
  assert.deepEqual(deliveryOptions(silent), { triggerTurn: false });

  await input({ source: "interactive", text: "dynamax run it in the background" }, ctx);
  const woken = await startRun();
  assert.equal((await store.load(woken))?.background?.origin.wakeOnComplete, true);
  assert.deepEqual(deliveryOptions(woken), { triggerTurn: true });
});

test("a failed tool-invoked workflow stays available to /workflow:inspector", async () => {
  const extension = captureWorkflowExtension();
  const inspector = extension.commands.get("workflow:inspector");
  if (!inspector) throw new Error("expected /workflow:inspector command");
  const notifications: string[] = [];
  const ctx = { ...HEADLESS_CTX, ui: { notify: (message: string) => notifications.push(message) } } as unknown as ExtensionCommandContext;
  const script = `
export const meta = { name: "failing-inspect-probe", description: "Failed inspector probe" };
export default async function run({ phase, log }) {
  phase("Doomed");
  log("failing workflow log");
  throw new Error("boom");
}
`;

  // A failed run comes back as a failed call, so the usage it spent can still reach the session.
  const failed = await extension.tool.execute("call-failing-inspect", { script }, undefined, () => {}, ctx);
  assert.ok(isRecord(failed));
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.details, { error: "workflow_failed", name: "failing-inspect-probe", message: "boom" });
  assert.match(JSON.stringify(failed.content), /Workflow failing-inspect-probe failed: boom/);
  await inspector.handler("", ctx);

  const inspection = notifications.at(-1) ?? "";
  assert.match(inspection, /Workflow inspector: failing-inspect-probe/);
  assert.match(inspection, /Phase: Doomed/);
  assert.match(inspection, /failing workflow log/);
});

test("a TUI tool-invoked workflow leaves the inspector closed so the agent's reply stays in view", async () => {
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

  assert.equal(customCalls(), 0);
});

test("the reopened inspector reports a failed tool-invoked run as failed", async () => {
  const extension = captureWorkflowExtension();
  const inspector = extension.commands.get("workflow:inspector");
  if (!inspector) throw new Error("expected /workflow:inspector command");
  const { ctx, customRenders } = createTuiContext(undefined, "inspector-failed-state");
  const script = `
export const meta = { name: "failed-state-probe", description: "Failed state probe" };
export default async function run({ phase }) {
  phase("Doomed");
  throw new Error("boom");
}
`;

  const failed = await extension.tool.execute("call-failed-state", { script }, undefined, () => {}, ctx);
  assert.ok(isRecord(failed));
  assert.equal(failed.isError, true);
  await inspector.handler("", ctx as ExtensionCommandContext);

  assert.match(customRenders().at(-1)?.[0] ?? "", /failed-state-probe.*✗ failed/);
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
    assert.match(tui.customRenders()[0]?.join("\n") ?? "", /Review findings/);
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

test("reopening retained results preserves the review when the viewer rejects", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:results");
  if (!command) throw new Error("expected /workflow:results command");
  await extension.tool.execute(
    "call-results-viewer-rejection",
    { script: codeReviewScript("Rejected viewer probe", RETAINED_REVIEW_RESULT) },
    undefined,
    () => {},
    HEADLESS_CTX,
  );

  const tui = createTuiContext();
  tui.ctx.ui.custom = async <T>(): Promise<T> => {
    throw new Error("viewer failed");
  };

  await command.handler("", tui.ctx as ExtensionCommandContext);

  assert.equal(tui.notifications().at(-1), "Review completed, but the findings viewer could not be opened.");
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
    reviewContext: { workflowName: "code-review", target: "PR", files: ["src/app.ts"] },
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

test("the picker's authored temporary workflow activates Dynamax for the run it starts", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow");
  if (!command) throw new Error("expected /workflow command");
  const statuses = new Map<string, string | undefined>();
  let armedBeforeIdle: { status: string | undefined; sent: number } | undefined;
  const ctx = {
    ...HEADLESS_CTX,
    hasUI: true,
    waitForIdle: async () => {
      armedBeforeIdle = { status: statuses.get("dynamax"), sent: extension.sentUserMessages.length };
    },
    ui: {
      select: async (_title: string, options: readonly string[]) => options.find((option) => option.startsWith("+ author a one-off workflow")),
      editor: async () => "inspect src and summarize risks",
      notify: () => {},
      setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
      theme: createTestTheme(),
    },
  } as unknown as ExtensionCommandContext;

  await command.handler("", ctx);

  assert.deepEqual(armedBeforeIdle, { status: undefined, sent: 0 }, "the one-shot is armed and sent only once the host is idle");
  assert.match(String(extension.sentUserMessages[0]), /inspect src and summarize risks/);
  assert.match(statuses.get("dynamax") ?? "", /next prompt/);
});

test("workflow inspector history stays isolated to its originating session", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:inspector");
  if (!command) throw new Error("expected /workflow:inspector command");
  const sessionA = {
    ...HEADLESS_CTX,
    sessionManager: createSessionManager("inspector-session-a"),
  } as ExtensionContext;
  const script = `
export const meta = { name: "inspector-session-probe", description: "Inspector session probe" };
export default async function run({ phase }) {
  phase("Scoped");
  return { ok: true };
}
`;

  await extension.tool.execute("call-inspector-session-a", { script }, undefined, () => {}, sessionA);

  const sessionB = createTuiContext(undefined, "inspector-session-b");
  await command.handler("", sessionB.ctx as ExtensionCommandContext);
  assert.equal(sessionB.customCalls(), 0);
  assert.equal(sessionB.notifications().at(-1), "No workflow inspector is available yet");

  const reopenedA = createTuiContext(undefined, "inspector-session-a");
  await command.handler("", reopenedA.ctx as ExtensionCommandContext);
  assert.equal(reopenedA.customCalls(), 1);
  assert.deepEqual(reopenedA.customOptions()[0], WORKFLOW_INSPECTOR_OVERLAY_OPTIONS);
  assert.match(reopenedA.customRenders().at(-1)?.join("\n") ?? "", /inspector-session-probe/);
});

test("the inspector shortcut opens the active workflow inspector while the workflow tool is running", async () => {
  const { tool, shortcuts } = captureWorkflowExtension();
  const { ctx, customCalls, customOptions, customRenders } = createTuiContext();
  const shortcut = shortcuts.find((candidate) => candidate.description === "Open workflow inspector");
  if (!shortcut) throw new Error("expected Dynamax inspector shortcut");
  const script = `
export const meta = { name: "inspect-live-shortcut-probe", description: "Live inspector shortcut probe" };
export default async function run({ phase }) {
  phase("Shortcut Live");
  globalThis["__piWorkflowShortcutLiveStarted"] = true;
  await globalThis["__piWorkflowShortcutLiveGate"];
  return { ok: true };
}
`;
  // Hold the run open so the shortcut can only find the active inspection: a completed
  // snapshot is recorded only when the run finishes.
  const runtime = globalThis as typeof globalThis & { __piWorkflowShortcutLiveGate?: Promise<void>; __piWorkflowShortcutLiveStarted?: boolean };
  const gate = Promise.withResolvers<void>();
  runtime.__piWorkflowShortcutLiveGate = gate.promise;

  try {
    const running = tool.execute("call-3", { script }, undefined, () => {}, ctx);
    await waitUntil(() => runtime.__piWorkflowShortcutLiveStarted === true, "live workflow body");

    await shortcut.handler(ctx);

    assert.equal(customCalls(), 1);
    assert.deepEqual(customOptions().at(-1), WORKFLOW_INSPECTOR_OVERLAY_OPTIONS);
    assert.match(customRenders().at(-1)?.join("\n") ?? "", /inspect-live-shortcut-probe.*● running · Shortcut Live/);
    gate.resolve();
    await running;
  } finally {
    gate.resolve();
    delete runtime.__piWorkflowShortcutLiveGate;
    delete runtime.__piWorkflowShortcutLiveStarted;
  }
});
