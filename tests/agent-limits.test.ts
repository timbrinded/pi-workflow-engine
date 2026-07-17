import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  WorkflowAgentLimiter,
  WorkflowAgentLimitError,
  WorkflowAgentTimeoutError,
} from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import type { WorkflowJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import type { AgentResumeContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";
import type { CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import {
  commandNames,
  createFakeWorktreeRegistry,
  createRunContext,
  runAgent,
} from "./agent-runner-fixtures.ts";

function textSession(input: {
  readonly prompt?: () => Promise<void>;
  readonly abort?: () => Promise<void>;
  readonly dispose?: () => void;
} = {}): Awaited<ReturnType<CreateAgentSession>> {
  return {
    session: {
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        systemPrompt: "Agent limits test",
        model: { provider: "test", id: "agent-limits" },
        thinkingLevel: "low",
      },
      prompt: input.prompt ?? (async () => {}),
      subscribe: () => () => {},
      dispose: input.dispose ?? (() => {}),
      abort: input.abort ?? (async () => {}),
      getAllTools: () => [],
      getActiveToolNames: () => [],
      getToolDefinition: () => undefined,
    },
  };
}

test("queued agents share the run limit and excess work never reaches the model", async () => {
  let releaseFirst: (() => void) | undefined;
  let firstStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  let promptCalls = 0;
  const createSession: CreateAgentSession = async () =>
    textSession({
      async prompt() {
        promptCalls++;
        if (promptCalls === 1) {
          firstStarted?.();
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
      },
    });
  const limiter = new WorkflowAgentLimiter(1);
  const rc = createRunContext({ createSession, agentLimiter: limiter });

  const first = runAgent(rc, "first");
  await started;
  const queued = runAgent(rc, "queued");
  releaseFirst?.();

  assert.equal(await first, "done");
  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof WorkflowAgentLimitError && error.code === "WORKFLOW_AGENT_LIMIT_EXCEEDED" && error.maxAgents === 1,
  );
  assert.equal(promptCalls, 1);
});

test("agent timeout aborts and disposes the session, then releases the semaphore", async () => {
  let sessions = 0;
  let aborts = 0;
  let disposals = 0;
  const createSession: CreateAgentSession = async () => {
    sessions++;
    if (sessions === 1) {
      return textSession({
        prompt: async () => await new Promise<void>(() => {}),
        abort: async () => {
          aborts++;
        },
        dispose: () => {
          disposals++;
        },
      });
    }
    return textSession({ dispose: () => disposals++ });
  };
  const rc = createRunContext({
    createSession,
    agentLimiter: new WorkflowAgentLimiter(2),
    agentTimeoutMs: 10,
  });

  await assert.rejects(
    () => runAgent(rc, "hang", { label: "slow" }),
    (error: unknown) =>
      error instanceof WorkflowAgentTimeoutError &&
      error.code === "WORKFLOW_AGENT_TIMEOUT" &&
      error.label === "slow" &&
      error.timeoutMs === 10,
  );
  assert.equal(await runAgent(rc, "after timeout"), "done");
  assert.equal(aborts, 1);
  assert.equal(disposals, 2);
});

test("timed-out isolated agents remove their disposable worktree", async () => {
  const fake = createFakeWorktreeRegistry({ repoCwd: process.cwd() });
  const rc = createRunContext({
    cwd: process.cwd(),
    createSession: async () => textSession({ prompt: async () => await new Promise<void>(() => {}) }),
    agentLimiter: new WorkflowAgentLimiter(1),
    agentTimeoutMs: 10,
    worktrees: fake.registry,
  });

  await assert.rejects(
    () => runAgent(rc, "isolated hang", { isolation: "worktree", resume: "off" }),
    WorkflowAgentTimeoutError,
  );
  assert.ok(commandNames(fake.calls).includes("worktree remove"));
});

test("host cancellation takes precedence over the per-agent timeout", async () => {
  const controller = new AbortController();
  const hostError = new WorkflowAbortError("host cancelled");
  const rc = createRunContext({
    createSession: async () => textSession({ prompt: async () => await new Promise<void>(() => {}) }),
    agentLimiter: new WorkflowAgentLimiter(1),
    agentTimeoutMs: 50,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(hostError), 5);

  await assert.rejects(
    () => runAgent(rc, "cancel me"),
    (error: unknown) => error === hostError,
  );
});

test("a replay hit consumes neither a live-agent admission nor provider work", async () => {
  let recorded:
    | { readonly key: string; readonly result: unknown; readonly identity: AgentResumeContext }
    | undefined;
  const recordingJournal: WorkflowJournal = {
    lookup: () => ({ hit: false }),
    async record(key, result, identity) {
      recorded = { key, result, identity };
      return { ok: true };
    },
  };
  const first = createRunContext({
    cwd: process.cwd(),
    createSession: async () => textSession(),
    journal: recordingJournal,
  });
  await runAgent(first, "cache me", { resume: "read-only" });
  assert.ok(recorded);

  const replayJournal: WorkflowJournal = {
    lookup: (key) => key === recorded?.key ? { hit: true, value: recorded.result } : { hit: false },
    async record() {
      return { ok: true };
    },
  };
  const limiter = new WorkflowAgentLimiter(1);
  const replayPrompts: string[] = [];
  const replay = createRunContext({
    cwd: process.cwd(),
    createSession: async () =>
      textSession({
        prompt: async () => {
          replayPrompts.push("prompt");
        },
      }),
    agentLimiter: limiter,
    journal: replayJournal,
  });

  assert.equal(await runAgent(replay, "cache me", { resume: "read-only" }), "done");
  assert.equal(await runAgent(replay, "one live call", { resume: "off" }), "done");
  assert.deepEqual(replayPrompts, ["prompt"]);
});
