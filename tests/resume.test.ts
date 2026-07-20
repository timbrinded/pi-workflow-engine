import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  runWorkflow,
  runWorkflowWithContext,
  type WorkflowContextOptions,
  type WorkflowProgress,
  type WorkflowRunContext,
} from "../.pi/extensions/pi-workflow-engine/src/engine.ts";
import type { AgentProgress, CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { WorkflowAgentLimiter } from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import { defaultAgentRetryScheduler } from "../.pi/extensions/pi-workflow-engine/src/agent-retry.ts";
import { hostWorkflowModelProfiles } from "../.pi/extensions/pi-workflow-engine/src/model-profiles.ts";
import { DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS, DEFAULT_WORKFLOW_MAX_AGENTS } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import {
  createWorkflowJournal,
  loadJournalEntries,
  workflowJournalPath,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { workflowRunRecordPath } from "../.pi/extensions/pi-workflow-engine/src/workflow-run-store.ts";
import { NoopPerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import type { LoadedWorkflow, WorkflowModule, WorkflowProgressEvent, WorkflowRef, WorkflowRunMetadata } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { WorktreeRegistry } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import { compileInlineWorkflow } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import {
  captureRepositoryResumeContext,
  FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
} from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import { captureTreeFingerprint } from "../.pi/extensions/pi-workflow-engine/src/tree-fingerprint.ts";
import {
  TEST_TOOL,
  TEST_TOOL_DEFINITION,
  assistantTextMessage,
  createAgentRunnerSession,
  createRegistry,
  testModel,
} from "./agent-runner-fixtures.ts";
import { createGitRepo, runGit } from "./resume-fixtures.ts";

interface CaptureProgress extends AgentProgress, WorkflowProgress {
  readonly logs: string[];
  readonly events: WorkflowProgressEvent[];
}

function createProgress(): CaptureProgress {
  const logs: string[] = [];
  const events: WorkflowProgressEvent[] = [];
  return {
    logs,
    events,
    agentQueued() {
      return 1;
    },
    agentStart() {},
    agentTool() {},
    agentDone() {},
    agentFailed() {},
    phase() {},
    event(event: WorkflowProgressEvent) {
      events.push(event);
    },
    log(message) {
      logs.push(message);
    },
  };
}

function workflowModule(name: string, run: WorkflowModule["default"]): LoadedWorkflow {
  return {
    meta: { name, description: "" },
    default: run,
    source: { kind: "fingerprint", fingerprint: `test:${name}:${run.toString()}` },
  };
}

async function sourceTreeFingerprint(root: string): Promise<string> {
  const capture = await captureTreeFingerprint({
    root,
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    maxBytes: 1 << 20,
    maxFiles: 128,
  });
  if (capture.kind === "unverifiable") throw new Error(capture.reason);
  return capture.fingerprint;
}

function contextOpts(resolveWorkflow?: (ref: WorkflowRef) => Promise<LoadedWorkflow>): WorkflowContextOptions {
  return { abortController: new AbortController(), submissionLimit: 16, resolveWorkflow, depth: 0, progressPrefix: "" };
}

function createLiveTextSession(onPrompt: (prompt: string) => void): CreateAgentSession {
  return async () => {
    let messages: AssistantMessage[] = [];
    let lastText: string | undefined;
    return {
      session: createAgentRunnerSession({
        get messages() {
          return messages;
        },
        systemPrompt: TEST_SYSTEM_PROMPT,
        model: TEST_MODEL,
        thinkingLevel: "low",
        async prompt(prompt) {
          onPrompt(prompt);
          lastText = `live:${prompt}`;
          messages = [assistantTextMessage(lastText)];
        },
        getLastAssistantText: () => lastText,
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
    };
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEST_MODEL = testModel("test", "resume-model");
const TEST_SYSTEM_PROMPT = "Stable resume test system prompt";

function createDelayedTextSession(delays: Record<string, number>, onPrompt: (prompt: string) => void): CreateAgentSession {
  return async () => {
    let messages: AssistantMessage[] = [];
    let lastText: string | undefined;
    return {
      session: createAgentRunnerSession({
        get messages() {
          return messages;
        },
        systemPrompt: TEST_SYSTEM_PROMPT,
        model: TEST_MODEL,
        thinkingLevel: "low",
        async prompt(prompt) {
          onPrompt(prompt);
          await delay(delays[prompt] ?? 0);
          lastText = `live:${prompt}`;
          messages = [assistantTextMessage(lastText)];
        },
        getLastAssistantText: () => lastText,
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
    };
  };
}

function createSequencedTextSession(onPrompt: (prompt: string) => void): CreateAgentSession {
  let next = 0;
  return async () => {
    const sequence = ++next;
    let messages: AssistantMessage[] = [];
    let lastText: string | undefined;
    return {
      session: createAgentRunnerSession({
        get messages() {
          return messages;
        },
        systemPrompt: TEST_SYSTEM_PROMPT,
        model: TEST_MODEL,
        thinkingLevel: "low",
        async prompt(prompt) {
          onPrompt(prompt);
          lastText = `live-${sequence}:${prompt}`;
          messages = [assistantTextMessage(lastText)];
        },
        getLastAssistantText: () => lastText,
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
    };
  };
}

async function runWithJournal(input: {
  readonly cwd: string;
  readonly mod: LoadedWorkflow;
  readonly resumeFrom?: string;
  readonly writeRunId: string;
  readonly createSession: CreateAgentSession;
  readonly resolveWorkflow?: (ref: WorkflowRef) => Promise<LoadedWorkflow>;
  readonly resumeEditedWorkflow?: boolean;
  readonly onProgress?: (progress: CaptureProgress) => void;
}): Promise<unknown> {
  const usage = createWorkflowUsageRecorder();
  const progress = createProgress();
  const journal = await createWorkflowJournal({
    resumePath: input.resumeFrom ? workflowJournalPath(input.cwd, input.resumeFrom) : undefined,
    writePath: workflowJournalPath(input.cwd, input.writeRunId),
  });
  const rc: WorkflowRunContext = {
    cwd: input.cwd,
    hostModel: undefined,
    modelRegistry: createRegistry([]),
    semaphore: new Semaphore(4),
    agentLimiter: new WorkflowAgentLimiter(DEFAULT_WORKFLOW_MAX_AGENTS),
    agentTimeoutMs: DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
    agentRetries: 0,
    resumeEditedWorkflow: input.resumeEditedWorkflow,
    retryScheduler: defaultAgentRetryScheduler,
    modelProfiles: hostWorkflowModelProfiles(undefined),
    progress,
    signal: undefined,
    perf: new NoopPerfRecorder(),
    usage,
    budget: createBudget(null, usage),
    journal,
    worktrees: new WorktreeRegistry(input.cwd),
    createSession: input.createSession,
  };

  const result = await runWorkflowWithContext(rc, progress, input.mod, "", contextOpts(input.resolveWorkflow));
  input.onProgress?.(progress);
  return result;
}

function fakeContext(cwd: string, signal?: AbortSignal): ExtensionContext {
  return {
    hasUI: false,
    cwd,
    model: undefined,
    modelRegistry: createRegistry([]),
    signal,
  } as unknown as ExtensionContext;
}

test("resume with the same workflow replays all completed agent results from journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-"));
  let livePrompts: string[] = [];
  const mod = workflowModule("linear", async (api) => {
      const first = await api.agent("first", { resume: "read-only", resumeInputs: ["."] });
      const second = await api.agent("second", { resume: "read-only", resumeInputs: ["."] });
    return [first, second];
  });

  const firstResult = await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });
  assert.deepEqual(firstResult, ["live:first", "live:second"]);
  assert.equal(livePrompts.length, 2);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).length, 2);

  livePrompts = [];
  const resumedResult = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(resumedResult, ["live:first", "live:second"]);
  assert.deepEqual(livePrompts, []);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "second-run"))).length, 2);
});

test("workflows with explicitly unverifiable provenance never replay cached agents", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-unverifiable-source-"));
  const mod: LoadedWorkflow = {
    meta: { name: "programmatic", description: "" },
    default: async (api) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] }),
    source: { kind: "unverifiable", reason: "programmatic test workflow" },
  };
  try {
    await runWithJournal({ cwd, mod, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });

    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod,
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });

    assert.deepEqual(livePrompts, ["same prompt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("changing workflow implementation invalidates all calls from the old source", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-suffix-"));
  const original = workflowModule("linear", async (api) => [
        await api.agent("a", { resume: "read-only", resumeInputs: ["."] }),
        await api.agent("b", { resume: "read-only", resumeInputs: ["."] }),
        await api.agent("c", { resume: "read-only", resumeInputs: ["."] }),
  ]);
  const changed = workflowModule("linear", async (api) => [
        await api.agent("a", { resume: "read-only", resumeInputs: ["."] }),
        await api.agent("changed", { resume: "read-only", resumeInputs: ["."] }),
        await api.agent("c", { resume: "read-only", resumeInputs: ["."] }),
  ]);

  await runWithJournal({
    cwd,
    mod: original,
    writeRunId: "first-run",
    createSession: createLiveTextSession(() => {}),
  });

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod: changed,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:a", "live:changed", "live:c"]);
  assert.deepEqual(livePrompts, ["a", "changed", "c"]);
  assert.equal((await loadJournalEntries(workflowJournalPath(cwd, "second-run"))).length, 3);
});

test("explicit edited-workflow resume reuses only behaviorally unchanged calls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-edited-"));
  const original = workflowModule("edited", async (api) => [
    await api.agent("early", { resume: "read-only", resumeInputs: ["."] }),
    await api.agent("stable", { resume: "read-only", resumeInputs: ["."] }),
    await api.agent("late", { resume: "read-only", resumeInputs: ["."] }),
  ]);
  const edited = workflowModule("edited", async (api) => [
    await api.agent("early changed", { resume: "read-only", resumeInputs: ["."] }),
    await api.agent("stable", { resume: "read-only", resumeInputs: ["."] }),
    await api.agent("late changed", { resume: "read-only", resumeInputs: ["."] }),
    await api.agent("new", { resume: "read-only", resumeInputs: ["."] }),
  ]);
  try {
    await runWithJournal({ cwd, mod: original, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    const livePrompts: string[] = [];
    let events: WorkflowProgressEvent[] = [];
    const result = await runWithJournal({
      cwd,
      mod: edited,
      resumeFrom: "first-run",
      resumeEditedWorkflow: true,
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
      onProgress: (progress) => {
        events = progress.events;
      },
    });

    assert.deepEqual(result, ["live:early changed", "live:stable", "live:late changed", "live:new"]);
    assert.deepEqual(livePrompts, ["early changed", "late changed", "new"]);
    assert.equal(events.filter((event) => event.type === "counter_delta" && event.key === "resume.cached").length, 1);
    assert.equal(events.filter((event) => event.type === "counter_delta" && event.key === "resume.live").length, 3);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edited-workflow resume keeps duplicate unkeyed calls ambiguous", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-edited-duplicates-"));
  const original = workflowModule("duplicates", async (api) => await api.parallel([
    () => api.agent("same", { resume: "read-only", resumeInputs: ["."] }),
    () => api.agent("same", { resume: "read-only", resumeInputs: ["."] }),
  ]));
  const edited = workflowModule("duplicates", async (api) => {
    api.log("edited wrapper");
    return await api.parallel([
      () => api.agent("same", { resume: "read-only", resumeInputs: ["."] }),
      () => api.agent("same", { resume: "read-only", resumeInputs: ["."] }),
    ]);
  });
  try {
    await runWithJournal({ cwd, mod: original, writeRunId: "first-run", createSession: createSequencedTextSession(() => {}) });
    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod: edited,
      resumeFrom: "first-run",
      resumeEditedWorkflow: true,
      writeRunId: "second-run",
      createSession: createSequencedTextSession((prompt) => livePrompts.push(prompt)),
    });
    assert.deepEqual(livePrompts, ["same", "same"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("edited-workflow resume still invalidates repository changes", async () => {
  const cwd = await createGitRepo();
  const original = workflowModule("edited-repository", async (api) =>
    await api.agent("same", { resume: "read-only" }));
  const edited = workflowModule("edited-repository", async (api) => {
    api.log("edited wrapper");
    return await api.agent("same", { resume: "read-only" });
  });
  try {
    await runWithJournal({ cwd, mod: original, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    await writeFile(join(cwd, "tracked.txt"), "changed\n", "utf8");
    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod: edited,
      resumeFrom: "first-run",
      resumeEditedWorkflow: true,
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });
    assert.deepEqual(livePrompts, ["same"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

async function assertRepositoryChangeInvalidates(
  cwd: string,
  mutate: () => Promise<void>,
  expectedReason: RegExp,
): Promise<void> {
  const mod = workflowModule("repository-context", async (api) => api.agent("same prompt", { resume: "read-only" }));
  await runWithJournal({ cwd, mod, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
  await mutate();

  const progress = createProgress();
  const livePrompts: string[] = [];
  const usage = createWorkflowUsageRecorder();
  const journal = await createWorkflowJournal({
    resumePath: workflowJournalPath(cwd, "first-run"),
    writePath: workflowJournalPath(cwd, "second-run"),
  });
  const rc: WorkflowRunContext = {
    cwd,
    hostModel: undefined,
    modelRegistry: createRegistry([]),
    semaphore: new Semaphore(4),
    agentLimiter: new WorkflowAgentLimiter(DEFAULT_WORKFLOW_MAX_AGENTS),
    agentTimeoutMs: DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
    agentRetries: 0,
    retryScheduler: defaultAgentRetryScheduler,
    modelProfiles: hostWorkflowModelProfiles(undefined),
    progress,
    signal: undefined,
    perf: new NoopPerfRecorder(),
    usage,
    budget: createBudget(null, usage),
    journal,
    worktrees: new WorktreeRegistry(cwd),
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
  };

  await runWorkflowWithContext(rc, progress, mod, "", contextOpts());
  assert.deepEqual(livePrompts, ["same prompt"]);
  assert.ok(progress.logs.some((line) => expectedReason.test(line)), `expected invalidation log ${expectedReason}, got ${progress.logs.join(" | ")}`);
}

test("resume keeps cache hits for unchanged git repository context", async () => {
  const cwd = await createGitRepo();
  try {
    const mod = workflowModule("unchanged-repository", async (api) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] }));
    await runWithJournal({ cwd, mod, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    const livePrompts: string[] = [];
    const result = await runWithJournal({
      cwd,
      mod,
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });

    assert.equal(result, "live:same prompt");
    assert.deepEqual(livePrompts, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume ignores its own journal files when the repository does not", async () => {
  const cwd = await createGitRepo({ ignoreJournal: false });
  try {
    const mod = workflowModule("self-journal", async (api) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] }));
    await runWithJournal({ cwd, mod, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });

    const livePrompts: string[] = [];
    const result = await runWithJournal({
      cwd,
      mod,
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });

    assert.equal(result, "live:same prompt");
    assert.deepEqual(livePrompts, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume fingerprints declared inputs relative to a workflow subdirectory", async () => {
  const root = await createGitRepo({ ignoreJournal: false });
  const cwd = join(root, "nested");
  await mkdir(cwd);
  try {
    await writeFile(join(cwd, "inside.txt"), "untracked version one\n", "utf8");
    await assertRepositoryChangeInvalidates(
      cwd,
      async () => {
        await writeFile(join(cwd, "inside.txt"), "untracked version two\n", "utf8");
      },
      /working tree contents changed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume supports an unchanged unborn repository", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-unborn-"));
  runGit(cwd, ["init"]);
  try {
    const mod = workflowModule("unborn-repository", async (api) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] }));
    await runWithJournal({ cwd, mod, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });

    const livePrompts: string[] = [];
    const result = await runWithJournal({
      cwd,
      mod,
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });

    assert.equal(result, "live:same prompt");
    assert.deepEqual(livePrompts, []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume invalidates cached agents when repository HEAD changes", async () => {
  const cwd = await createGitRepo();
  try {
    await assertRepositoryChangeInvalidates(
      cwd,
      async () => {
        await writeFile(join(cwd, "tracked.txt"), "committed change\n", "utf8");
        runGit(cwd, ["add", "tracked.txt"]);
        runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "change"]);
      },
      /repository HEAD changed/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const state of ["staged", "unstaged", "untracked"] as const) {
  test(`resume invalidates cached agents when ${state} content changes at the same path`, async () => {
    const cwd = await createGitRepo();
    const path = join(cwd, state === "untracked" ? "scratch.txt" : "tracked.txt");
    try {
      await writeFile(path, "dirty version one\n", "utf8");
      if (state === "staged") runGit(cwd, ["add", "tracked.txt"]);

      await assertRepositoryChangeInvalidates(
        cwd,
        async () => {
          await writeFile(path, "dirty version two\n", "utf8");
          if (state === "staged") runGit(cwd, ["add", "tracked.txt"]);
        },
        /working tree contents changed/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("resume invalidates cached agents when saved workflow source changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-saved-source-"));
  const sourcePath = join(cwd, "saved-workflow.ts");
  const run = async (api: Parameters<WorkflowModule["default"]>[0]) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] });
  const mod = (fingerprint: string): LoadedWorkflow => ({
    meta: { name: "saved-source", description: "" },
    default: run,
    source: { kind: "file", path: sourcePath, root: cwd, fingerprint },
  });
  try {
    await writeFile(join(cwd, "package.json"), '{"name":"saved-source-fixture"}\n', "utf8");
    await writeFile(sourcePath, "// source version one\n", "utf8");
    await runWithJournal({ cwd, mod: mod(await sourceTreeFingerprint(cwd)), writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    await writeFile(sourcePath, "// source version two\n", "utf8");

    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod: mod(await sourceTreeFingerprint(cwd)),
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });
    assert.deepEqual(livePrompts, ["same prompt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume invalidates file-backed workflows when a runtime helper changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-helper-source-"));
  const workflowDir = join(cwd, "workflows");
  const sourceDir = join(cwd, "src");
  const sourcePath = join(workflowDir, "saved-workflow.ts");
  const helperPath = join(sourceDir, "helper.ts");
  const mod = (fingerprint: string): LoadedWorkflow => ({
    meta: { name: "helper-source", description: "" },
    default: async (api) => api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] }),
    source: { kind: "file", path: sourcePath, root: cwd, fingerprint },
  });
  try {
    await mkdir(workflowDir);
    await mkdir(sourceDir);
    await writeFile(join(cwd, "package.json"), '{"name":"resume-helper-fixture"}\n', "utf8");
    await writeFile(sourcePath, 'import "../src/helper.ts";\nexport default async () => "ok";\n', "utf8");
    await writeFile(helperPath, "export const helper = 'one';\n", "utf8");
    await runWithJournal({ cwd, mod: mod(await sourceTreeFingerprint(cwd)), writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    await writeFile(helperPath, "export const helper = 'two';\n", "utf8");

    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod: mod(await sourceTreeFingerprint(cwd)),
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });
    assert.deepEqual(livePrompts, ["same prompt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("repository capture and normal workflow startup honor an already-aborted host signal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-abort-"));
  const controller = new AbortController();
  controller.abort(new Error("stop repository capture"));
  let workflowExecuted = false;
  const mod = workflowModule("aborted-capture", async () => {
    workflowExecuted = true;
    return "unexpected";
  });
  try {
    await assert.rejects(() => captureRepositoryResumeContext(cwd, ["."], controller.signal), /stop repository capture/);
    await assert.rejects(() => runWorkflow(fakeContext(cwd, controller.signal), mod, ""), /stop repository capture/);
    assert.equal(workflowExecuted, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resume invalidates cached agents when inline workflow source changes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-inline-source-"));
  const source = (version: string) => `
export const meta = { name: "inline-source", description: "" };
export default async function run(api) {
  // ${version}
  return api.agent("same prompt", { resume: "read-only", resumeInputs: ["."] });
}
`;
  try {
    const first = compileInlineWorkflow(source("version one"));
    await runWithJournal({ cwd, mod: first, writeRunId: "first-run", createSession: createLiveTextSession(() => {}) });
    const livePrompts: string[] = [];
    await runWithJournal({
      cwd,
      mod: compileInlineWorkflow(source("version two")),
      resumeFrom: "first-run",
      writeRunId: "second-run",
      createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    });
    assert.deepEqual(livePrompts, ["same prompt"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("parallel resume replays stable keys despite completion-order journal writes", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-parallel-"));
  const original = workflowModule("parallel", async (api) =>
    await api.parallel([
      () => api.agent("slow", { resume: "read-only", resumeInputs: ["."] }),
      () => api.agent("fast", { resume: "read-only", resumeInputs: ["."] }),
    ]),
  );
  const edited = workflowModule("parallel", async (api) => {
    api.log("edited wrapper");
    return await api.parallel([
      () => api.agent("slow", { resume: "read-only", resumeInputs: ["."] }),
      () => api.agent("fast", { resume: "read-only", resumeInputs: ["."] }),
    ]);
  });

  await runWithJournal({
    cwd,
    mod: original,
    writeRunId: "first-run",
    createSession: createDelayedTextSession({ slow: 20, fast: 0 }, () => {}),
  });
  assert.deepEqual(
    (await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).map((entry) =>
      entry.version === 2 ? entry.result : entry.value,
    ),
    ["live:fast", "live:slow"],
  );

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod: edited,
    resumeFrom: "first-run",
    resumeEditedWorkflow: true,
    writeRunId: "second-run",
    createSession: createDelayedTextSession({}, (prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:slow", "live:fast"]);
  assert.deepEqual(livePrompts, []);
});

test("pipeline resume replays later stages by stable item keys", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-pipeline-"));
  const mod = workflowModule("pipeline", async (api) =>
    await api.pipeline(
      ["slow", "fast"],
      async (_acc, item) => await api.agent(`stage1:${item}`, { resume: "read-only", resumeInputs: ["."] }),
      async (acc, item) => `${acc}|${await api.agent(`stage2:${item}`, { resume: "read-only", resumeInputs: ["."] })}`,
    ),
  );

  await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createDelayedTextSession({ "stage1:slow": 20, "stage1:fast": 0 }, () => {}),
  });

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createDelayedTextSession({}, (prompt) => livePrompts.push(prompt)),
  });

  assert.deepEqual(result, ["live:stage1:slow|live:stage2:slow", "live:stage1:fast|live:stage2:fast"]);
  assert.deepEqual(livePrompts, []);
});

test("cacheKey disambiguates repeated identical agent prompts for resume", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-cache-key-"));
  const mod = workflowModule("repeated", async (api) =>
    await api.parallel([
      () => api.agent("same", { cacheKey: "item:a", resume: "read-only", resumeInputs: ["."] }),
      () => api.agent("same", { cacheKey: "item:b", resume: "read-only", resumeInputs: ["."] }),
    ]),
  );

  const first = await runWithJournal({
    cwd,
    mod,
    writeRunId: "first-run",
    createSession: createSequencedTextSession(() => {}),
  });

  const livePrompts: string[] = [];
  const resumed = await runWithJournal({
    cwd,
    mod,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createSequencedTextSession((prompt) => livePrompts.push(prompt)),
  });

  assert.ok(Array.isArray(first));
  assert.deepEqual([...first].sort(), ["live-1:same", "live-2:same"]);
  assert.deepEqual(resumed, first);
  assert.deepEqual(livePrompts, []);
});

test("sub-workflow agents share the same resume journal", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-child-"));
  const child = workflowModule("child", async (api) => api.agent("child", { resume: "read-only", resumeInputs: ["."] }));
  const parent = workflowModule("parent", async (api) => [
    await api.agent("parent-1", { resume: "read-only", resumeInputs: ["."] }),
    await api.workflow("child"),
    await api.agent("parent-2", { resume: "read-only", resumeInputs: ["."] }),
  ]);
  const resolveWorkflow = async (ref: WorkflowRef) => {
    if (ref === "child") return child;
    throw new Error(`unexpected workflow ${ref}`);
  };

  await runWithJournal({
    cwd,
    mod: parent,
    writeRunId: "first-run",
    createSession: createLiveTextSession(() => {}),
    resolveWorkflow,
  });
  assert.deepEqual(
    (await loadJournalEntries(workflowJournalPath(cwd, "first-run"))).map((entry) =>
      entry.version === 2 ? entry.result : entry.value,
    ),
    ["live:parent-1", "live:child", "live:parent-2"],
  );

  const livePrompts: string[] = [];
  const result = await runWithJournal({
    cwd,
    mod: parent,
    resumeFrom: "first-run",
    writeRunId: "second-run",
    createSession: createLiveTextSession((prompt) => livePrompts.push(prompt)),
    resolveWorkflow,
  });

  assert.deepEqual(result, ["live:parent-1", "live:child", "live:parent-2"]);
  assert.deepEqual(livePrompts, []);
});

test("runWorkflow reports run metadata and logs the generated run id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-run-meta-"));
  let metadata: WorkflowRunMetadata | undefined;
  const mod = workflowModule("metadata", async () => "ok");
  await mkdir(join(cwd, ".pi", ".workflow-runs"), { recursive: true });
  await writeFile(workflowJournalPath(cwd, "old-run"), "", "utf8");

  const result = await runWorkflow(fakeContext(cwd), mod, "", {
    runId: "new-run",
    resumeFromRunId: "old-run",
    onRunMetadata(value) {
      metadata = value;
    },
  });

  assert.equal(result, "ok");
  assert.deepEqual(metadata, {
    runId: "new-run",
    resumedFromRunId: "old-run",
    journalPath: workflowJournalPath(cwd, "new-run"),
    recordPath: workflowRunRecordPath(cwd, "new-run"),
  });
});
