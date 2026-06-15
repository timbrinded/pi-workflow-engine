import assert from "node:assert/strict";
import { test } from "bun:test";
import { inlineCompileErrorResult, normalizeWorkflowToolRequest } from "../.pi/extensions/pi-workflow-engine/index.ts";
import { compileInlineWorkflow, InlineWorkflowCompileError } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

function createFakeApi(overrides: Partial<WorkflowApi> = {}): WorkflowApi {
  const agent = (async (_prompt: string, opts?: AgentOptions) => (opts?.schema ? { ok: true } : "agent text")) as WorkflowApi["agent"];
  return {
    agent,
    workflow: async () => {
      throw new Error("sub-workflows are not enabled in this context");
    },
    parallel: async <T>(thunks: Array<() => Promise<T>>) => await Promise.all(thunks.map((thunk) => thunk())),
    pipeline,
    phase() {},
    log() {},
    progress() {},
    args: "",
    cwd: process.cwd(),
    signal: undefined,
    ...overrides,
  };
}

test("normalizeWorkflowToolRequest accepts named workflow requests", () => {
  assert.deepEqual(normalizeWorkflowToolRequest({ name: " code-review " }), { kind: "named", name: "code-review" });
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
