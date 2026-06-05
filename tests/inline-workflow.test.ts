import assert from "node:assert/strict";
import { test } from "bun:test";
import { compileInlineWorkflow, InlineWorkflowCompileError } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

function createFakeApi(overrides: Partial<WorkflowApi> = {}, onAgent?: (opts: AgentOptions | undefined) => void): WorkflowApi {
  const agent = (async (_prompt: string, opts?: AgentOptions) => {
    onAgent?.(opts);
    return opts?.schema ? { ok: true } : "agent text";
  }) as WorkflowApi["agent"];

  return {
    agent,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("compileInlineWorkflow extracts meta and runs a default async function", async () => {
  const phases: string[] = [];
  const mod = compileInlineWorkflow(`
export const meta = {
  name: "inline-smoke",
  description: "Smoke workflow",
  phases: [{ title: "Run" }],
};

export default async function run({ phase, args }) {
  phase("Run");
  return { summary: ` + "`args:${args}`" + ` };
}
`);

  const result = await mod.default(createFakeApi({ args: "hello", phase: (title) => phases.push(title) }));

  assert.deepEqual(mod.meta, { name: "inline-smoke", description: "Smoke workflow", phases: [{ title: "Run" }] });
  assert.deepEqual(result, { summary: "args:hello" });
  assert.deepEqual(phases, ["Run"]);
});

test("compileInlineWorkflow injects Type for structured agent schemas", async () => {
  let capturedSchema: unknown;
  const mod = compileInlineWorkflow(`
export const meta = { name: "schema-inline", description: "Schema inline" };

export default async ({ agent }) => {
  const Result = Type.Object({ ok: Type.Boolean() });
  const result = await agent("return ok", { schema: Result, thinkingLevel: "low" });
  return { summary: result?.ok ? "ok" : "missing" };
}
`);

  const result = await mod.default(createFakeApi({}, (opts) => {
    capturedSchema = opts?.schema;
  }));

  assert.deepEqual(result, { summary: "ok" });
  assert.equal(isRecord(capturedSchema) ? capturedSchema.type : undefined, "object");
});

test("compileInlineWorkflow rejects non-literal metadata", () => {
  assert.throws(
    () =>
      compileInlineWorkflow(`
export const meta = makeMeta();
export default async function run(api) { return "nope"; }
`),
    InlineWorkflowCompileError,
  );
});
