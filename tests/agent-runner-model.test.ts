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
import { createBudget, WorkflowBudgetExceededError, type WorkflowBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import {
  agentJournalKey,
  createMemoryBackedJournal,
  type WorkflowJournal,
  type JournalLookup,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import {
  WorktreeRegistry,
  type WorktreeGitCommandOptions,
  type WorktreeGitRunner,
} from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import {
  createAgentResumeContext,
  type AgentResumeBaseContext,
} from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";

type FindCall = { readonly provider: string; readonly modelId: string };

const RESUME_BASE_CONTEXT: AgentResumeBaseContext = {
  repository: {
    state: "non-git",
    head: "non-git",
    dirtyFingerprint: "model-resume-fixture",
    verifiable: true,
  },
  workflow: { name: "model-resume-test", sourceFingerprint: "source-a", verifiable: true },
};

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
  readonly budget?: WorkflowBudget;
  readonly usage?: ReturnType<typeof createWorkflowUsageRecorder>;
  readonly journal?: WorkflowJournal;
  readonly worktrees?: WorktreeRegistry;
}): RunContext {
  const usage = input.usage ?? createWorkflowUsageRecorder();
  const cwd = input.cwd ?? process.cwd();
  return {
    cwd,
    hostModel: input.hostModel,
    modelRegistry: input.modelRegistry ?? createRegistry([]),
    semaphore: new Semaphore(1),
    progress: input.progress ?? createProgress(),
    signal: undefined,
    perf: new PerfRecorder(),
    usage,
    budget: input.budget ?? createBudget(null, usage),
    journal: input.journal ?? createMemoryBackedJournal(),
    worktrees: input.worktrees ?? new WorktreeRegistry(cwd),
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

function createFakeWorktreeRegistry(input: {
  readonly repoCwd: string;
  readonly insideGit?: boolean;
  readonly patch?: string;
  readonly changed?: boolean;
  readonly removeResult?: { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly error?: string };
}): { readonly registry: WorktreeRegistry; readonly calls: WorktreeGitCommandOptions[] } {
  const calls: WorktreeGitCommandOptions[] = [];
  const runner: WorktreeGitRunner = {
    async runGit(options) {
      calls.push(options);
      const command = options.args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") {
        return { ok: true, stdout: input.insideGit === false ? "false\n" : "true\n", stderr: "" };
      }
      if (options.args[0] === "worktree" && options.args[1] === "add") return { ok: true, stdout: "", stderr: "" };
      if (options.args[0] === "worktree" && options.args[1] === "remove") return input.removeResult ?? { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  };
  return {
    calls,
    registry: new WorktreeRegistry(input.repoCwd, {
      runner,
      patchCapture: async () => ({ patch: input.patch ?? "", changed: input.changed ?? false }),
    }),
  };
}

function commandNames(calls: readonly WorktreeGitCommandOptions[]): string[] {
  return calls.map((call) => call.args.slice(0, 2).join(" "));
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

test("runAgent resume cache uses effective model identity rather than model ref syntax", async () => {
  const target = testModel("anthropic", "claude-cache");
  const prompt = "hello";
  const bareOptions = { label: "model-cache", model: "claude-cache" };
  const qualifiedOptions = { label: "model-cache", model: "anthropic/claude-cache" };
  assert.equal(agentJournalKey(prompt, bareOptions), agentJournalKey(prompt, qualifiedOptions));

  const journal = createMemoryBackedJournal([
    {
      key: agentJournalKey(prompt, bareOptions),
      value: "cached-value",
      context: createAgentResumeContext(RESUME_BASE_CONTEXT, target),
    },
  ]);
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  const result = await runAgent(
    createRunContext({ createSession, modelRegistry: createRegistry([target]), journal }),
    prompt,
    qualifiedOptions,
    RESUME_BASE_CONTEXT,
  );

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 0);
});

test("runAgent invalidates resume cache when the inherited host model changes", async () => {
  const hostA = testModel("anthropic", "claude-host-a");
  const hostB = testModel("anthropic", "claude-host-b");
  const prompt = "hello";
  const opts = { label: "inherited-model-cache" };
  const journal = createMemoryBackedJournal([
    {
      key: agentJournalKey(prompt, opts),
      value: "cached-value",
      context: createAgentResumeContext(RESUME_BASE_CONTEXT, hostA),
    },
  ]);
  const progress = createProgress();
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  const result = await runAgent(
    createRunContext({ createSession, hostModel: hostB, progress, journal }),
    prompt,
    opts,
    RESUME_BASE_CONTEXT,
  );

  assert.equal(result, "done");
  assert.equal(createSessionCalls, 1);
  assert.ok(progress.events.includes("log:inherited-model-cache: cached result invalidated (effective model changed)"));
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

test("runAgent returns cached journal results before queueing, budget checks, or session creation", async () => {
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };
  const progress = createProgress();
  const usage = createWorkflowUsageRecorder();
  const journal = createMemoryBackedJournal([{ key: agentJournalKey("hello", { label: "cached" }), value: "cached-value" }]);
  const exhausted: WorkflowBudget = { total: 100, spent: () => 250, remaining: () => 0 };

  const result = await runAgent(createRunContext({ createSession, progress, usage, journal, budget: exhausted }), "hello", { label: "cached" });

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 0);
  assert.deepEqual(progress.events, ["log:cached: using cached result from workflow journal"]);
  assert.equal(usage.snapshot().agents.length, 0);
});

test("runAgent records successful live results into the journal", async () => {
  const recorded: Array<{ readonly key: string; readonly value: unknown }> = [];
  const journal: WorkflowJournal = {
    lookup(): JournalLookup {
      return { hit: false };
    },
    async record(key, value) {
      recorded.push({ key, value });
      return { ok: true };
    },
  };

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), journal }), "hello", { label: "live" });

  assert.equal(result, "done");
  assert.deepEqual(recorded, [{ key: agentJournalKey("hello", { label: "live" }), value: "done" }]);
});

test("runAgent returns cached results when journal write-through fails", async () => {
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup(): JournalLookup {
      return { hit: true, value: "cached-value" };
    },
    async record() {
      return { ok: false, error: "disk full" };
    },
  };
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  const result = await runAgent(createRunContext({ createSession, progress, journal }), "hello", { label: "cached" });

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 0);
  assert.ok(progress.events.includes("log:cached: workflow journal write failed (disk full); future resume may be incomplete"));
});

test("runAgent returns live results when journal append fails", async () => {
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup(): JournalLookup {
      return { hit: false };
    },
    async record() {
      return { ok: false, error: "read-only filesystem" };
    },
  };

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), progress, journal }), "hello", { label: "live" });

  assert.equal(result, "done");
  assert.ok(progress.events.includes("log:live: workflow journal write failed (read-only filesystem); future resume may be incomplete"));
});

test("runAgent with worktree isolation creates an isolated cwd and returns a patch wrapper", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd, patch: "diff --git a/file b/file\n", changed: true });
  let observedCwd = "";
  const createSession: CreateAgentSession = async (options) => {
    observedCwd = options.cwd ?? "";
    return createTextSession();
  };

  const result = await runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry }), "hello", {
    label: "isolated",
    isolation: "worktree",
  });

  assert.deepEqual(result, { result: "done", patch: "diff --git a/file b/file\n", changed: true });
  assert.notEqual(observedCwd, repoCwd);
  assert.ok(observedCwd.startsWith("/tmp/pi-workflow-"));
  assert.deepEqual(commandNames(calls), ["rev-parse --is-inside-work-tree", "worktree add", "worktree remove"]);
  assert.equal(registry.size, 0);
});

test("runAgent removes an isolated worktree when the agent fails", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd });
  const createSession: CreateAgentSession = async () => ({
    session: {
      state: { messages: [] },
      async prompt() {
        throw new Error("agent failed");
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
    },
  });

  await assert.rejects(
    () => runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry }), "hello", { label: "isolated", isolation: "worktree" }),
    /agent failed/,
  );

  assert.deepEqual(commandNames(calls), ["rev-parse --is-inside-work-tree", "worktree add", "worktree remove"]);
  assert.equal(registry.size, 0);
});

test("runAgent reports isolated worktree cleanup failures without masking success", async () => {
  const repoCwd = "/repo";
  const progress = createProgress();
  const { registry } = createFakeWorktreeRegistry({
    repoCwd,
    patch: "diff --git a/file b/file\n",
    changed: true,
    removeResult: { ok: false, stdout: "", stderr: "", error: "busy" },
  });

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), cwd: repoCwd, worktrees: registry, progress }), "hello", {
    label: "isolated",
    isolation: "worktree",
  });

  assert.deepEqual(result, { result: "done", patch: "diff --git a/file b/file\n", changed: true });
  assert.ok(progress.events.includes("log:isolated: failed to remove isolated worktree (busy)"));
  assert.equal(registry.size, 1);
});

test("runAgent rejects worktree isolation outside a git work tree", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd, insideGit: false });
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  await assert.rejects(
    () => runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry }), "hello", { label: "isolated", isolation: "worktree" }),
    /not inside a git work tree/,
  );

  assert.equal(createSessionCalls, 0);
  assert.deepEqual(commandNames(calls), ["rev-parse --is-inside-work-tree"]);
});

test("runAgent leaves the non-isolated cwd unchanged and does not touch worktrees", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd });
  let observedCwd = "";
  const createSession: CreateAgentSession = async (options) => {
    observedCwd = options.cwd ?? "";
    return createTextSession();
  };

  const result = await runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry }), "hello", { label: "plain" });

  assert.equal(result, "done");
  assert.equal(observedCwd, repoCwd);
  assert.deepEqual(calls, []);
});

test("runAgent cached isolated hits skip worktree creation", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd });
  const opts = { label: "cached-isolated", isolation: "worktree" as const };
  const cached = { result: "cached", patch: "diff", changed: true };
  const journal = createMemoryBackedJournal([{ key: agentJournalKey("hello", opts), value: cached }]);
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  const result = await runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry, journal }), "hello", opts);

  assert.deepEqual(result, cached);
  assert.equal(createSessionCalls, 0);
  assert.deepEqual(calls, []);
});

test("runAgent re-checks budget after waiting for a concurrency slot", async () => {
  let spent = 0;
  const budget: WorkflowBudget = {
    total: 100,
    spent: () => spent,
    remaining: () => Math.max(0, 100 - spent),
  };
  const progress = createProgress();
  let createSessionCalls = 0;
  let releaseFirstPrompt!: () => void;
  const firstPromptCanFinish = new Promise<void>((resolve) => {
    releaseFirstPrompt = resolve;
  });
  let markFirstPromptEntered!: () => void;
  const firstPromptEntered = new Promise<void>((resolve) => {
    markFirstPromptEntered = resolve;
  });
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return {
      session: {
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
        async prompt() {
          markFirstPromptEntered();
          await firstPromptCanFinish;
        },
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
      },
    };
  };
  const rc = createRunContext({ createSession, budget, progress });

  const first = runAgent(rc, "first", { label: "first" });
  await firstPromptEntered;
  const second = runAgent(rc, "second", { label: "second" });
  const secondRejected = assert.rejects(second, WorkflowBudgetExceededError);
  await Promise.resolve();
  assert.ok(progress.events.includes("queued:second"));

  spent = 100;
  releaseFirstPrompt();

  assert.equal(await first, "done");
  await secondRejected;
  assert.equal(createSessionCalls, 1);
  assert.ok(progress.events.some((event) => event.includes("failed:second:WorkflowBudgetExceededError")));
  assert.ok(!progress.events.includes("start:second"));
  assert.ok(!progress.events.includes("done:second"));
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
