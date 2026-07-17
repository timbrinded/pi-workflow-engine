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
  commandNames,
  createFakeWorktreeRegistry,
  createProgress,
  createRunContext,
  createTextSession,
  runAgent,
  writeProjectSkill,
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

test("dynamic-tool fallback transfers session ownership before disposal", async () => {
  let createCalls = 0;
  let disposeCalls = 0;
  const createSession: CreateAgentSession = async () => {
    createCalls++;
    return {
      session: {
        state: { messages: [] },
        async prompt() {},
        subscribe() {
          return () => {};
        },
        dispose() {
          disposeCalls++;
          throw new Error("fallback disposal failed");
        },
        async abort() {},
      },
    };
  };

  await assert.rejects(
    () => runAgent(createRunContext({ createSession }), "hello", {
      tools: ["read"],
      toolHints: ["search"],
    }),
    /fallback disposal failed/,
  );
  assert.equal(createCalls, 1);
  assert.equal(disposeCalls, 1);
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
