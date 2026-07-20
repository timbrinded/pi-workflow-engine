import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import type { CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import {
  WorkflowBudgetExceededError,
  type WorkflowBudget,
} from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import type { WorkflowJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { WorktreeRegistry } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import { resumeContextMismatchReason, type AgentResumeContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import {
  isExternalSearchLikeTool,
  WorkflowToolHintUnavailableError,
} from "../.pi/extensions/pi-workflow-engine/src/tool-capabilities.ts";
import {
  commandNames,
  createAgentRunnerSession,
  createFakeWorktreeRegistry,
  createProgress,
  createRunContext,
  createTextSession,
  executeTestFinalAnswer,
  runAgent,
} from "./agent-runner-fixtures.ts";
import { createGitRepo, runGit } from "./resume-fixtures.ts";

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
  assert.deepEqual(commandNames(calls), [
    "rev-parse --is-inside-work-tree",
    "worktree add",
    "rev-parse --verify",
    "worktree remove",
  ]);
  assert.equal(registry.size, 0);
});

test("isolated agents that mutate the main repository are not recorded", async () => {
  const repoCwd = await createGitRepo();
  const { registry } = createFakeWorktreeRegistry({ repoCwd });
  let records = 0;
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: false };
    },
    async record() {
      records += 1;
      return { ok: true };
    },
  };
  const createSession: CreateAgentSession = async () => {
    const created = createTextSession();
    return {
      session: {
        ...created.session,
        async prompt() {
          await writeFile(join(repoCwd, "escaped-worktree.txt"), "changed\n", "utf8");
        },
      },
    };
  };

  try {
    const result = await runAgent(
      createRunContext({ createSession, cwd: repoCwd, worktrees: registry, journal }),
      "hello",
      { isolation: "worktree" },
    );
    assert.deepEqual(result, { result: "done", patch: "", changed: false });
    assert.equal(records, 0);
  } finally {
    await rm(repoCwd, { recursive: true, force: true });
  }
});

test("resume off disables journal reads and writes for isolated agents", async () => {
  const repoCwd = "/repo";
  const { registry } = createFakeWorktreeRegistry({ repoCwd });
  let journalCalls = 0;
  const journal: WorkflowJournal = {
    lookup() {
      journalCalls += 1;
      return { hit: true, value: { result: "stale", patch: "", changed: false } };
    },
    async record() {
      journalCalls += 1;
      return { ok: true };
    },
  };
  const result = await runAgent(
    createRunContext({ createSession: async () => createTextSession(), cwd: repoCwd, worktrees: registry, journal }),
    "hello",
    { label: "isolated-off", isolation: "worktree", resume: "off" },
  );
  assert.deepEqual(result, { result: "done", patch: "", changed: false });
  assert.equal(journalCalls, 0);
});

test("runAgent removes an isolated worktree when the agent fails", async () => {
  const repoCwd = "/repo";
  const { registry, calls } = createFakeWorktreeRegistry({ repoCwd });
  const createSession: CreateAgentSession = async () => ({
    session: createAgentRunnerSession({
      state: { messages: [] },
      async prompt() {
        throw new Error("agent failed");
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
    }),
  });

  await assert.rejects(
    () => runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry }), "hello", { label: "isolated", isolation: "worktree" }),
    /agent failed/,
  );

  assert.deepEqual(commandNames(calls), [
    "rev-parse --is-inside-work-tree",
    "worktree add",
    "rev-parse --verify",
    "worktree remove",
  ]);
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

test("runAgent prepares isolated tool and workspace identity before a cached hit", async () => {
  const repoCwd = await createGitRepo();
  const registry = new WorktreeRegistry(repoCwd);
  const opts = { label: "cached-isolated", isolation: "worktree" as const };
  const cached = { result: "cached", patch: "", changed: false };
  const journal: WorkflowJournal = {
    lookup() {
      return { hit: true, value: cached };
    },
    async record() {
      return { ok: true };
    },
  };
  let createSessionCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createSessionCalls += 1;
    return createTextSession();
  };

  try {
    const result = await runAgent(createRunContext({ createSession, cwd: repoCwd, worktrees: registry, journal }), "hello", opts);
    assert.deepEqual(result, cached);
    assert.equal(createSessionCalls, 1);
    assert.equal(registry.size, 0);
  } finally {
    await rm(repoCwd, { recursive: true, force: true });
  }
});

test("isolated replay binds to prepared contents and same-tree commit identity", async () => {
  const repoCwd = await mkdtemp(join(tmpdir(), "pi-workflow-unborn-replay-"));
  runGit(repoCwd, ["init"]);
  await writeFile(join(repoCwd, "source.txt"), "first\n", "utf8");
  const registry = new WorktreeRegistry(repoCwd);
  let stored: { readonly key: string; readonly result: unknown; readonly identity: AgentResumeContext } | undefined;
  const journal: WorkflowJournal = {
    lookup(key, identity) {
      if (!stored || stored.key !== key) return { hit: false };
      const mismatch = resumeContextMismatchReason(stored.identity, identity);
      return mismatch ? { hit: false, reason: mismatch } : { hit: true, value: stored.result };
    },
    async record(key, result, identity) {
      stored = { key, result, identity };
      return { ok: true };
    },
  };
  let promptCalls = 0;
  const createSession: CreateAgentSession = async () => {
    const created = createTextSession();
    return {
      session: {
        ...created.session,
        async prompt() {
          promptCalls += 1;
        },
      },
    };
  };
  const run = async () => await runAgent(
    createRunContext({ createSession, cwd: repoCwd, worktrees: registry, journal }),
    "inspect source",
    { isolation: "worktree" },
  );

  try {
    await run();
    assert.equal(promptCalls, 1);
    const unbornIdentity = stored?.identity.repository;
    assert.equal(unbornIdentity?.state, "isolated");

    await run();
    assert.equal(promptCalls, 1);

    await writeFile(join(repoCwd, "source.txt"), "second\n", "utf8");
    await run();
    assert.equal(promptCalls, 2);

    runGit(repoCwd, ["add", "source.txt"]);
    runGit(repoCwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "first committed baseline"]);
    await run();
    assert.equal(promptCalls, 3);
    const firstCommitIdentity = stored?.identity.repository;
    assert.equal(firstCommitIdentity?.state, "isolated");

    runGit(repoCwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "same tree, different history"]);
    await run();
    assert.equal(promptCalls, 4);
    const secondCommitIdentity = stored?.identity.repository;
    assert.equal(secondCommitIdentity?.state, "isolated");
    if (firstCommitIdentity?.state !== "isolated" || secondCommitIdentity?.state !== "isolated") {
      assert.fail("expected isolated commit identities");
    }
    assert.equal(secondCommitIdentity.workingTreeFingerprint, firstCommitIdentity.workingTreeFingerprint);
    assert.notEqual(secondCommitIdentity.head, firstCommitIdentity.head);
  } finally {
    await registry.removeAll();
    await rm(repoCwd, { recursive: true, force: true });
  }
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
      session: createAgentRunnerSession({
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
        async prompt() {
          markFirstPromptEntered();
          await firstPromptCanFinish;
        },
        getLastAssistantText: () => "done",
        subscribe() {
          return () => {};
        },
        dispose() {},
        async abort() {},
      }),
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
  let observedNoTools: "all" | "builtin" | undefined;
  let activatedTools: readonly string[] = [];
  const createSession: CreateAgentSession = async (options) => {
    observedTools = options.tools;
    observedExcludeTools = options.excludeTools;
    observedNoTools = options.noTools;
    return {
      session: createAgentRunnerSession({
        state: { messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] },
        async prompt() {
          await executeTestFinalAnswer(options, { ok: true });
        },
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
      }),
    };
  };

  const result = await runAgent(createRunContext({ createSession }), "hello", {
    label: "dynamic-tools",
    tools: ["read", "bash", "grep", "find", "ls"],
    toolHints: ["search"],
    schema: Type.Object({ ok: Type.Boolean() }),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(observedTools, undefined);
  assert.equal(observedExcludeTools, undefined);
  assert.equal(observedNoTools, "builtin");
  assert.deepEqual(activatedTools, ["read", "bash", "grep", "find", "ls", "final_answer", "ffgrep", "mgrep", "ast-grep"]);
});

test("external-search tool hints select web capabilities but exclude local and mutating search tools", async () => {
  assert.equal(isExternalSearchLikeTool({ name: "web_search", description: "Search the internet and return webpage URLs" }), true);
  assert.equal(isExternalSearchLikeTool({ name: "web", description: "Tool for accessing the internet" }), true);
  assert.equal(isExternalSearchLikeTool({ name: "parallel-web-extract", description: "Extract a URL" }), true);
  assert.equal(isExternalSearchLikeTool({ name: "search_query", description: "Search the internet and return results" }), true);
  assert.equal(isExternalSearchLikeTool({ name: "grep", description: "Search local files" }), false);
  assert.equal(isExternalSearchLikeTool({ name: "fffind", description: "Find files in the workspace and report their URLs" }), false);
  assert.equal(isExternalSearchLikeTool({ name: "slack_search", description: "Search messages and files in Slack" }), false);
  assert.equal(isExternalSearchLikeTool({ name: "search_replace", description: "Search and replace text on a website" }), false);
  assert.equal(isExternalSearchLikeTool({ name: "searchReplace", description: "Search and replace text on a website" }), false);
  assert.equal(
    isExternalSearchLikeTool({
      name: "web_search",
      description: "Search the internet and return webpage URLs",
      sourceInfo: {
        path: "<builtin:web_search>",
        source: "builtin",
        scope: "builtin",
        origin: "builtin",
      },
    }),
    false,
  );

  let activatedTools: readonly string[] = [];
  const createSession: CreateAgentSession = async (options) => ({
    session: createAgentRunnerSession({
      state: { messages: [{ role: "assistant", content: [] }] },
      async prompt() {
        await executeTestFinalAnswer(options, { ok: true });
      },
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
      getAllTools() {
        return [
          { name: "read", description: "Read local files" },
          { name: "grep", description: "Search local files" },
          { name: "web_search", description: "Search the internet and return webpage URLs" },
          { name: "url_fetch", description: "Fetch and extract an HTTP webpage" },
          { name: "search_replace", description: "Search and replace text on a website" },
        ];
      },
      setActiveToolsByName(toolNames) {
        activatedTools = toolNames;
      },
    }),
  });

  const result = await runAgent(createRunContext({ createSession }), "research", {
    tools: [],
    toolHints: ["external-search"],
    requireToolHints: true,
    schema: Type.Object({ ok: Type.Boolean() }),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(activatedTools, ["final_answer", "web_search", "url_fetch"]);
});

test("required tool hints fail before prompting when no installed capability matches", async () => {
  let prompted = false;
  let disposed = false;
  const createSession: CreateAgentSession = async () => ({
    session: createAgentRunnerSession({
      state: { messages: [] },
      async prompt() {
        prompted = true;
      },
      subscribe() {
        return () => {};
      },
      dispose() {
        disposed = true;
      },
      async abort() {},
      getAllTools() {
        return [{ name: "grep", description: "Search local files" }];
      },
      setActiveToolsByName() {},
    }),
  });

  await assert.rejects(
    () => runAgent(createRunContext({ createSession }), "research", {
      tools: [],
      toolHints: ["external-search"],
      requireToolHints: true,
    }),
    WorkflowToolHintUnavailableError,
  );
  assert.equal(prompted, false);
  assert.equal(disposed, true);
});
