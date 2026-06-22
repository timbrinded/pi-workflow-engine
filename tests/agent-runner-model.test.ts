import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  resolveAgentModel,
  runAgent,
  type AgentProgress,
  type CreateAgentSession,
  type RunContext,
} from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

type FindCall = { readonly provider: string; readonly modelId: string };

function testModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function createRegistry(models: readonly Model<Api>[], calls: FindCall[] = []): Pick<ModelRegistry, "find"> {
  return {
    find(provider, modelId) {
      calls.push({ provider, modelId });
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
  };
}

function createProgress(): AgentProgress & { readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    agentQueued(_phase, label) {
      events.push(`queued:${label}`);
      return events.length;
    },
    agentStart(_phase, label) {
      events.push(`start:${label}`);
    },
    agentTool(label, tool) {
      events.push(`tool:${label}:${tool}`);
    },
    agentDone(label) {
      events.push(`done:${label}`);
    },
    agentFailed(label, error) {
      events.push(`failed:${label}:${String(error)}`);
    },
    log(message) {
      events.push(`log:${message}`);
    },
  };
}

function createRunContext(input: {
  readonly createSession: CreateAgentSession;
  readonly hostModel?: Model<Api>;
  readonly modelRegistry?: Pick<ModelRegistry, "find">;
  readonly progress?: AgentProgress;
  readonly cwd?: string;
}): RunContext {
  return {
    cwd: input.cwd ?? process.cwd(),
    hostModel: input.hostModel,
    modelRegistry: input.modelRegistry ?? createRegistry([]),
    semaphore: new Semaphore(1),
    progress: input.progress ?? createProgress(),
    signal: undefined,
    perf: new PerfRecorder(),
    usage: createWorkflowUsageRecorder(),
    createSession: input.createSession,
  };
}

function createTextSession(): Awaited<ReturnType<CreateAgentSession>> {
  return {
    session: {
      state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
    },
  };
}

async function writeProjectSkill(cwd: string, name: string): Promise<void> {
  const dir = join(cwd, ".pi", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill for workflow subagent skill filtering.\n---\n\n# ${name}\n`,
    "utf8",
  );
}

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

test("runAgent dynamically enables installed search-like tools", async () => {
  let observedTools: readonly string[] | undefined;
  let observedExcludeTools: readonly string[] | undefined;
  let activatedTools: readonly string[] = [];
  const createSession: CreateAgentSession = async (options) => {
    observedTools = options.tools;
    observedExcludeTools = options.excludeTools;
    return {
      session: {
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
        async prompt() {},
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
        getAllTools() {
          return [
            { name: "read" },
            { name: "bash" },
            { name: "grep" },
            { name: "find" },
            { name: "ls" },
            { name: "ffgrep" },
            { name: "mgrep" },
            { name: "ast-grep" },
            { name: "workflow", description: "Run a workflow" },
            { name: "search_replace" },
          ];
        },
        setActiveToolsByName(toolNames) {
          activatedTools = toolNames;
        },
      },
    };
  };

  const result = await runAgent(createRunContext({ createSession }), "hello", {
    label: "dynamic-tools",
    tools: ["read", "bash", "grep", "find", "ls"],
    toolHints: ["search"],
    schema: Type.Object({ ok: Type.Boolean() }),
  });

  assert.equal(result, null);
  assert.equal(observedTools, undefined);
  assert.deepEqual(observedExcludeTools, ["edit", "write"]);
  assert.deepEqual(activatedTools, ["read", "bash", "grep", "find", "ls", "final_answer", "ffgrep", "mgrep", "ast-grep"]);
});

test("runAgent falls back to concrete tools when dynamic tool APIs are unavailable", async () => {
  const calls: Array<{ readonly tools?: readonly string[]; readonly excludeTools?: readonly string[] }> = [];
  let firstPrompted = false;
  let secondPrompted = false;
  let firstDisposed = false;

  const createSession: CreateAgentSession = async (options) => {
    calls.push({ tools: options.tools, excludeTools: options.excludeTools });
    const isFirstCall = calls.length === 1;
    return {
      session: {
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: isFirstCall ? "wide" : "strict" }] }] },
        async prompt() {
          if (isFirstCall) firstPrompted = true;
          else secondPrompted = true;
        },
        subscribe() {
          return () => {};
        },
        dispose() {
          if (isFirstCall) firstDisposed = true;
        },
        async abort() {},
      },
    };
  };

  const result = await runAgent(createRunContext({ createSession }), "hello", {
    label: "dynamic-tools-fallback",
    tools: ["read", "bash", "grep", "find", "ls"],
    toolHints: ["search"],
    schema: Type.Object({ ok: Type.Boolean() }),
  });

  assert.equal(result, null);
  assert.deepEqual(calls, [
    { tools: undefined, excludeTools: ["edit", "write"] },
    { tools: ["read", "bash", "grep", "find", "ls", "final_answer"], excludeTools: undefined },
  ]);
  assert.equal(firstPrompted, false);
  assert.equal(secondPrompted, true);
  assert.equal(firstDisposed, true);
});

test("runAgent filters explicitly requested skills and auto-adds read when tools are restricted", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-skill-test-"));
  try {
    await writeProjectSkill(cwd, "workflow-code-review-actions");
    let observedTools: readonly string[] | undefined;
    let observedSkills: readonly string[] = [];
    let observedPrompt = "";
    const createSession: CreateAgentSession = async (options) => {
      observedTools = options.tools;
      observedSkills = options.resourceLoader?.getSkills().skills.map((skill) => skill.name) ?? [];
      return {
        session: {
          state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
          async prompt(text) {
            observedPrompt = text;
          },
          subscribe() {
            return () => {};
          },
          dispose() {},
          async abort() {},
        },
      };
    };

    const result = await runAgent(createRunContext({ createSession, cwd }), "hello", {
      label: "skilled",
      tools: [],
      skills: ["workflow-code-review-actions"],
    });

    assert.equal(result, "done");
    assert.deepEqual(observedTools, ["read"]);
    assert.deepEqual(observedSkills, ["workflow-code-review-actions"]);
    assert.match(observedPrompt, /Workflow subagent skills enabled: workflow-code-review-actions/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runAgent rejects unknown explicit skills before creating a subagent session", async () => {
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  await assert.rejects(
    () => runAgent(createRunContext({ createSession }), "hello", { label: "missing-skill", skills: ["missing-skill-for-test"] }),
    /Unknown subagent skill: missing-skill-for-test/,
  );

  assert.equal(createSessionCalls, 0);
});
