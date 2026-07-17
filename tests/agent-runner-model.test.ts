import assert from "node:assert/strict";
import { test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  resolveAgentModel,
  type CreateAgentSession,
} from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import {
  WorkflowBudgetExceededError,
  type WorkflowBudget,
} from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import {
  createProgress,
  createRegistry,
  createRunContext,
  createTextSession,
  runAgent,
  testModel,
  type FindCall,
} from "./agent-runner-fixtures.ts";

test("resolveAgentModel uses provider-qualified refs and preserves additional slashes in model ids", () => {
  const target = testModel("openrouter", "anthropic/claude-3.5-sonnet");
  const calls: FindCall[] = [];
  const resolved = resolveAgentModel("openrouter/anthropic/claude-3.5-sonnet", createRegistry([target], calls), undefined);

  assert.equal(resolved.model, target);
  assert.deepEqual(resolved.requested, {
    ref: "openrouter/anthropic/claude-3.5-sonnet",
    provider: "openrouter",
    id: "anthropic/claude-3.5-sonnet",
  });
  assert.deepEqual(calls, [{ provider: "openrouter", modelId: "anthropic/claude-3.5-sonnet" }]);
});

test("resolveAgentModel keeps bare model ids as Anthropic shorthand", () => {
  const target = testModel("anthropic", "claude-opus-4-5");
  const calls: FindCall[] = [];
  const resolved = resolveAgentModel("claude-opus-4-5", createRegistry([target], calls), undefined);

  assert.equal(resolved.model, target);
  assert.deepEqual(resolved.requested, {
    ref: "claude-opus-4-5",
    provider: "anthropic",
    id: "claude-opus-4-5",
  });
  assert.deepEqual(calls, [{ provider: "anthropic", modelId: "claude-opus-4-5" }]);
});

test("resolveAgentModel inherits the host model only when model is omitted", () => {
  const hostModel = testModel("anthropic", "claude-host");
  const calls: FindCall[] = [];
  const resolved = resolveAgentModel(undefined, createRegistry([], calls), hostModel);

  assert.equal(resolved.model, hostModel);
  assert.equal(resolved.requested, undefined);
  assert.deepEqual(calls, []);
});

test("resolveAgentModel rejects unknown explicit model refs instead of falling back", () => {
  const hostModel = testModel("anthropic", "claude-host");
  const calls: FindCall[] = [];

  assert.throws(
    () => resolveAgentModel("openai/gpt-missing", createRegistry([], calls), hostModel),
    /Agent model "openai\/gpt-missing" not found \(resolved as openai\/gpt-missing\)\./,
  );
  assert.deepEqual(calls, [{ provider: "openai", modelId: "gpt-missing" }]);
});

test("resolveAgentModel rejects malformed explicit model refs before registry lookup", () => {
  for (const modelRef of ["", " ", " openai/gpt", "/gpt", "openai/", "openai//gpt"]) {
    const calls: FindCall[] = [];
    assert.throws(() => resolveAgentModel(modelRef, createRegistry([], calls), undefined), /Invalid agent model ref/);
    assert.deepEqual(calls, []);
  }
});

test("runAgent passes provider-qualified models into subagent sessions", async () => {
  const target = testModel("openai", "gpt-test");
  const calls: FindCall[] = [];
  let observedModel: Model<Api> | undefined;
  const createSession: CreateAgentSession = async (options) => {
    observedModel = options.model;
    return createTextSession();
  };

  const result = await runAgent(
    createRunContext({ createSession, modelRegistry: createRegistry([target], calls) }),
    "hello",
    { label: "modelled", model: "openai/gpt-test" },
  );

  assert.equal(result, "done");
  assert.equal(observedModel, target);
  assert.deepEqual(calls, [{ provider: "openai", modelId: "gpt-test" }]);
});


test("runAgent fails fast on unknown explicit model refs before creating a subagent session", async () => {
  const hostModel = testModel("anthropic", "claude-host");
  const progress = createProgress();
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  await assert.rejects(
    () =>
      runAgent(
        createRunContext({ createSession, hostModel, modelRegistry: createRegistry([]), progress }),
        "hello",
        { label: "strict", model: "openai/missing" },
      ),
    /Agent model "openai\/missing" not found \(resolved as openai\/missing\)\./,
  );

  assert.equal(createSessionCalls, 0);
  assert.ok(progress.events.some((event) => event.includes('failed:strict:Error: Agent model "openai/missing" not found')));
});

test("runAgent refuses to start once the run is over budget", async () => {
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };
  const exhausted: WorkflowBudget = { total: 100, spent: () => 250, remaining: () => 0 };

  await assert.rejects(
    () => runAgent(createRunContext({ createSession, budget: exhausted }), "hello", { label: "broke" }),
    WorkflowBudgetExceededError,
  );
  assert.equal(createSessionCalls, 0);
});
