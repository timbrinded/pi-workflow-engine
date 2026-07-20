import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type, type TSchema } from "typebox";
import type { CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import type { WorkflowBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import {
  agentJournalKey,
  type JournalLookup,
  type WorkflowJournal,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import type { AgentResumeContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import {
  DEFAULT_SESSION_MODEL,
  RESUME_BASE_CONTEXT,
  TEST_TOOL,
  TEST_TOOL_DEFINITION,
  createAgentRunnerSession,
  createProgress,
  createRegistry,
  createRunContext,
  createTextSession,
  executeTestFinalAnswer,
  runAgent,
  testModel,
} from "./agent-runner-fixtures.ts";

test("runAgent resume cache uses effective model identity rather than model ref syntax", async () => {
  const target = testModel("anthropic", "claude-cache");
  const prompt = "hello";
  const bareOptions = { label: "model-cache", model: "claude-cache", resume: "read-only" as const, resumeInputs: [] };
  const qualifiedOptions = { label: "model-cache", model: "anthropic/claude-cache", resume: "read-only" as const, resumeInputs: [] };
  assert.equal(agentJournalKey(prompt, bareOptions), agentJournalKey(prompt, qualifiedOptions));

  let observedModel: AgentResumeContext["session"]["model"] | undefined;
  const journal: WorkflowJournal = {
    lookup(_key, identity) {
      observedModel = identity.session.model;
      return { hit: true, value: "cached-value" };
    },
    async record() {
      return { ok: true };
    },
  };
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async (options) => {
    createSessionCalls += 1;
    return createTextSession(options.model);
  };

  const result = await runAgent(
    createRunContext({ createSession, modelRegistry: createRegistry([target]), journal }),
    prompt,
    qualifiedOptions,
    RESUME_BASE_CONTEXT,
  );

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 1);
  assert.deepEqual(observedModel, { provider: "anthropic", id: "claude-cache" });
});

test("runAgent invalidates resume cache when the inherited host model changes", async () => {
  const hostA = testModel("anthropic", "claude-host-a");
  const hostB = testModel("anthropic", "claude-host-b");
  const prompt = "hello";
  const opts = { label: "inherited-model-cache", resume: "read-only" as const, resumeInputs: [] };
  const journal: WorkflowJournal = {
    lookup(_key, identity) {
      return identity.session.model.id === hostA.id
        ? { hit: true, value: "cached-value" }
        : { hit: false, reason: "effective model changed" };
    },
    async record() {
      return { ok: true };
    },
  };
  const progress = createProgress();
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async (options) => {
    createSessionCalls += 1;
    return createTextSession(options.model);
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


test("runAgent resolves replay identity before returning a cached result without spending budget", async () => {
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };
  const progress = createProgress();
  const usage = createWorkflowUsageRecorder();
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: "cached-value" };
    },
    async record() {
      return { ok: true };
    },
  };
  const exhausted: WorkflowBudget = { total: 100, spent: () => 250, remaining: () => 0 };

  const result = await runAgent(createRunContext({ createSession, progress, usage, journal, budget: exhausted }), "hello", {
    label: "cached",
    resume: "read-only",
    resumeInputs: [],
  });

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 1);
  assert.ok(progress.events.includes("log:cached: using cached result from workflow journal"));
});

test("tool-free structured agents can replay without fingerprinting the workspace", async () => {
  const schema = Type.Object({ ok: Type.Boolean() });
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: { ok: true } };
    },
    async record() {
      return { ok: true };
    },
  };
  const createSession: CreateAgentSession = async (options) => {
    const finalTool = options.customTools?.find((tool) => tool.name === "final_answer");
    if (!finalTool) throw new Error("expected final-answer tool");
    return {
      session: createAgentRunnerSession({
        state: {
          messages: [],
          systemPrompt: `Work in ${options.cwd}`,
          model: DEFAULT_SESSION_MODEL,
          thinkingLevel: "low",
        },
        async prompt() {
          throw new Error("cached synthesis must not prompt");
        },
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
        getAllTools() {
          return [{
            name: finalTool.name,
            description: finalTool.description,
            parameters: finalTool.parameters,
            promptGuidelines: [],
            sourceInfo: { path: "<sdk:final_answer>", source: "sdk", scope: "temporary", origin: "top-level" },
          }];
        },
        getActiveToolNames() {
          return [finalTool.name];
        },
        getToolDefinition(name) {
          return name === finalTool.name ? finalTool : undefined;
        },
      }),
    };
  };

  const result = await runAgent(
    createRunContext({ createSession, cwd: process.cwd(), journal }),
    "synthesize",
    { resume: "read-only", tools: [], schema },
  );
  assert.deepEqual(result, { ok: true });
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

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), journal }), "hello", {
    label: "live",
    resume: "read-only",
    resumeInputs: [],
  });

  assert.equal(result, "done");
  assert.deepEqual(recorded, [{ key: agentJournalKey("hello", { label: "live", resumeInputs: [] }), value: "done" }]);
});

test("shared-workspace agents run live without touching the journal by default", async () => {
  let lookups = 0;
  let records = 0;
  const journal: WorkflowJournal = {
    lookup() {
      lookups += 1;
      return { hit: true, value: "stale" };
    },
    async record() {
      records += 1;
      return { ok: true };
    },
  };

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), journal }), "hello", {
    label: "default-live",
  });
  assert.equal(result, "done");
  assert.equal(lookups, 0);
  assert.equal(records, 0);
});

test("read-only workspace replay defaults to the Git-visible repository contract", async () => {
  let journalCalls = 0;
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup() {
      journalCalls += 1;
      return { hit: true, value: "stale" };
    },
    async record() {
      journalCalls += 1;
      return { ok: true };
    },
  };

  const result = await runAgent(
    createRunContext({ createSession: async () => createTextSession(), journal, progress }),
    "hello",
    { label: "missing-input-contract", resume: "read-only" },
  );

  assert.equal(result, "stale");
  assert.equal(journalCalls, 2);
  assert.ok(!progress.events.some((event) => event.includes("resume disabled")));
});

test("read-only agents that mutate the repository are not recorded", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-read-only-contract-"));
  let records = 0;
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: false };
    },
    async record() {
      records += 1;
      return { ok: true };
    },
  };
  const createSession: CreateAgentSession = async () => ({
    session: createAgentRunnerSession({
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        systemPrompt: "Test system prompt",
        model: DEFAULT_SESSION_MODEL,
        thinkingLevel: "low",
      },
      async prompt() {
        await writeFile(join(cwd, "mutation.txt"), "changed\n", "utf8");
      },
      getLastAssistantText: () => "done",
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
      getAllTools() {
        return [TEST_TOOL];
      },
      getActiveToolNames() {
        return [TEST_TOOL.name];
      },
      getToolDefinition(name) {
        return name === TEST_TOOL.name ? TEST_TOOL_DEFINITION : undefined;
      },
    }),
  });
  try {
    assert.equal(
      await runAgent(createRunContext({ createSession, cwd, progress, journal }), "hello", {
        label: "contract",
        resume: "read-only",
        resumeInputs: ["."],
      }),
      "done",
    );
    assert.equal(records, 0);
    assert.ok(progress.events.some((event) => event.includes("read-only resume contract was not recorded")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cache hits are invalidated when session disposal changes the repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-cache-dispose-race-"));
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: "cached-value" };
    },
    async record() {
      return { ok: true };
    },
  };
  let sessions = 0;
  let prompts = 0;
  const createSession: CreateAgentSession = async () => {
    sessions += 1;
    const created = createTextSession();
    return {
      session: {
        ...created.session,
        async prompt() {
          prompts += 1;
        },
        dispose() {
          if (sessions === 1) writeFileSync(join(cwd, "changed-during-dispose.txt"), "changed\n", "utf8");
        },
      },
    };
  };

  try {
    const result = await runAgent(
      createRunContext({ createSession, cwd, progress, journal }),
      "hello",
      { resume: "read-only", resumeInputs: ["."] },
    );
    assert.equal(result, "done");
    assert.equal(sessions, 2);
    assert.equal(prompts, 1);
    assert.ok(progress.events.some((event) => event.includes("cached result invalidated after cleanup")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cache hits are invalidated when session setup changes the repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-cache-setup-race-"));
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: "cached-value" };
    },
    async record() {
      return { ok: true };
    },
  };
  let prompts = 0;
  const createSession: CreateAgentSession = async () => {
    writeFileSync(join(cwd, "changed-during-setup.txt"), "changed\n", "utf8");
    const created = createTextSession();
    return {
      session: {
        ...created.session,
        async prompt() {
          prompts += 1;
        },
      },
    };
  };

  try {
    assert.equal(
      await runAgent(createRunContext({ createSession, cwd, progress, journal }), "hello", { resume: "read-only", resumeInputs: ["."] }),
      "done",
    );
    assert.equal(prompts, 1);
    assert.ok(progress.events.some((event) => event.includes("cached result invalidated (working tree contents changed)")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume off never inspects hostile schemas", async () => {
  const schema = new Proxy<Record<string, unknown>>({}, {
    ownKeys() {
      throw new Error("schema identity must not be inspected");
    },
  });
  const result = await runAgent(
    createRunContext({
      createSession: async (options) => {
        const created = createTextSession();
        return {
          session: {
            ...created.session,
            async prompt() {
              await executeTestFinalAnswer(options, { ok: true });
            },
          },
        };
      },
    }),
    "hello",
    { resume: "off", schema: schema as unknown as TSchema },
  );
  assert.deepEqual(result, { ok: true });
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

  const result = await runAgent(createRunContext({ createSession, progress, journal }), "hello", {
    label: "cached",
    resume: "read-only",
    resumeInputs: [],
  });

  assert.equal(result, "cached-value");
  assert.equal(createSessionCalls, 1);
  assert.ok(progress.events.includes("log:cached: workflow journal write failed (disk full); future resume may be incomplete"));
});

test("invalid cached text values are treated as misses", async () => {
  const progress = createProgress();
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: { stale: true } };
    },
    async record() {
      return { ok: true };
    },
  };
  const result = await runAgent(
    createRunContext({ createSession: async () => createTextSession(), progress, journal }),
    "hello",
    { label: "invalid-cache", resume: "read-only", resumeInputs: [] },
  );
  assert.equal(result, "done");
  assert.ok(progress.events.includes("log:invalid-cache: cached result invalidated (cached text result is not a string)"));
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

  const result = await runAgent(createRunContext({ createSession: async () => createTextSession(), progress, journal }), "hello", {
    label: "live",
    resume: "read-only",
    resumeInputs: [],
  });

  assert.equal(result, "done");
  assert.ok(progress.events.includes("log:live: workflow journal write failed (read-only filesystem); future resume may be incomplete"));
});
