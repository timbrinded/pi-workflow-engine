import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createBudget, WorkflowBudgetExceededError } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import {
  runClassifier,
  WorkflowClassifierError,
  WorkflowClassifierUnavailableError,
} from "../.pi/extensions/pi-workflow-engine/src/classify.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import type { CreateAgentSession, RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { createRunContext, createTextSession } from "./agent-runner-fixtures.ts";

type ClassifierRegistry = Pick<ModelRegistry, "find" | "classify" | "getAvailableOfType" | "getModelOfType">;
type ClassifierModelRef = Parameters<ModelRegistry["classify"]>[0];

const JEV = { type: "classifier", provider: "typesafe", id: "jev-latest", name: "Jev", api: "typesafe-classifier", input: ["text"], contextWindow: 8192 } as unknown as ClassifierModelRef;
const CLEF = { ...JEV, provider: "cloudflare-workers-ai", id: "@cf/cloudflare/clef" } as ClassifierModelRef;

const CONTEXT: ClassifierContext = {
  state: { finding: "Null dereference in parser" },
  questions: { duplicate: { type: "bool", instructions: "Is this a duplicate?", criteria: { true: "Same defect", false: "Different defect" } } },
};

function classifierResult(overrides: Partial<ClassifierResult> = {}): ClassifierResult {
  return {
    api: "typesafe-classifier",
    provider: "typesafe",
    model: "jev-latest",
    answers: { duplicate: { type: "bool", probability: 0.9 } },
    usage: { input: 30, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 34, cost: { input: 0.001, output: 0.0005, cacheRead: 0, cacheWrite: 0, total: 0.0015 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  } as ClassifierResult;
}

function classifierRun(input: {
  readonly available?: readonly ClassifierModelRef[];
  readonly result?: ClassifierResult;
  readonly budget?: number;
  readonly agentTimeoutMs?: number;
  readonly classify?: ClassifierRegistry["classify"];
} = {}): { rc: RunContext; usage: ReturnType<typeof createWorkflowUsageRecorder>; classified: ClassifierModelRef[] } {
  const classified: ClassifierModelRef[] = [];
  const registry: ClassifierRegistry = {
    find: () => undefined,
    async getAvailableOfType() {
      return (input.available ?? [JEV]) as never;
    },
    getModelOfType: ((_type: string, provider: string, id: string) =>
      [JEV, CLEF].find((model) => model.provider === provider && model.id === id)) as ClassifierRegistry["getModelOfType"],
    async classify(model, context, options) {
      classified.push(model);
      return input.classify ? await input.classify(model, context, options) : input.result ?? classifierResult();
    },
  };
  const usage = createWorkflowUsageRecorder();
  const createSession: CreateAgentSession = async () => createTextSession();
  const rc: RunContext = {
    ...createRunContext({ createSession, usage, budget: createBudget(input.budget ?? null, usage), agentTimeoutMs: input.agentTimeoutMs }),
    createSession,
    modelRegistry: registry,
  };
  return { rc, usage, classified };
}

test("classify uses the first credentialed classifier and records its usage like an agent", async () => {
  const { rc, usage, classified } = classifierRun();

  const answers = await runClassifier(rc, CONTEXT, { phase: "Triage" });

  assert.deepEqual(answers, { duplicate: { type: "bool", probability: 0.9 } });
  assert.deepEqual(classified, [JEV]);
  const [agent] = usage.snapshot().agents;
  assert.equal(agent?.label, "classify:typesafe/jev-latest");
  assert.equal(agent?.phase, "Triage");
  assert.equal(agent?.usage.output, 4);
  assert.equal(rc.budget.spent(), 4);
});

test("classify resolves an explicit provider/id and rejects unknown refs or a host without classifiers", async () => {
  const explicit = classifierRun();
  await runClassifier(explicit.rc, CONTEXT, { model: "cloudflare-workers-ai/@cf/cloudflare/clef", label: "dedup" });
  assert.deepEqual(explicit.classified, [CLEF]);
  assert.equal(explicit.usage.snapshot().agents[0]?.label, "dedup");

  await assert.rejects(() => runClassifier(explicit.rc, CONTEXT, { model: "jev-latest" }), WorkflowClassifierUnavailableError);
  await assert.rejects(() => runClassifier(classifierRun({ available: [] }).rc, CONTEXT), /No classifier model has working credentials/);
  await assert.rejects(
    () => runClassifier(createRunContext({ createSession: async () => createTextSession() }), CONTEXT),
    WorkflowClassifierUnavailableError,
  );
});

test("a failed classifier call still counts its usage, and a spent budget stops the call before it starts", async () => {
  const failed = classifierRun({ result: classifierResult({ stopReason: "error", errorMessage: "rate limited", answers: {} }) });
  await assert.rejects(() => runClassifier(failed.rc, CONTEXT), (error: unknown) =>
    error instanceof WorkflowClassifierError && /classifier error: rate limited/.test(error.message));
  assert.equal(failed.usage.snapshot().totals.output, 4);

  const spent = classifierRun({ budget: 4 });
  await runClassifier(spent.rc, CONTEXT);
  await assert.rejects(() => runClassifier(spent.rc, CONTEXT), WorkflowBudgetExceededError);
  assert.equal(spent.classified.length, 1);
});

test("a stalled classifier gives its concurrency slot back at the per-agent timeout", async () => {
  const stalled = classifierRun({
    agentTimeoutMs: 20,
    classify: (_model, _context, options) =>
      new Promise((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(classifierResult({ stopReason: "aborted", answers: {} })), { once: true });
      }),
  });

  await assert.rejects(() => runClassifier(stalled.rc, CONTEXT, { label: "slow" }), /slow: classifier timed out after 20ms/);
});

test("a model preference list uses the first ref with working credentials", async () => {
  const run = classifierRun({ available: [CLEF] });
  await runClassifier(run.rc, CONTEXT, { model: ["typesafe/jev-latest", "cloudflare-workers-ai/@cf/cloudflare/clef"] });
  assert.deepEqual(run.classified, [CLEF]);

  await assert.rejects(() => runClassifier(classifierRun({ available: [] }).rc, CONTEXT, { model: ["typesafe/jev-latest"] }), WorkflowClassifierUnavailableError);
});
