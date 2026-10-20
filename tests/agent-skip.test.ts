import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { WorkflowAgentSkippedError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { parallel, Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { WorkflowJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { ProgressTracker } from "../.pi/extensions/pi-workflow-engine/src/progress.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { assistantTextMessage, createRunContext, createTextSession, runAgent } from "./agent-runner-fixtures.ts";

const WORK_UNTIL_SKIPPED = "work until skipped";
const SPENT_OUTPUT_TOKENS = 7;

function tracker(): ProgressTracker {
  return new ProgressTracker({ hasUI: false } as unknown as ExtensionContext, "skip-test", "skip-test-run");
}

function rowId(progress: ProgressTracker, label: string): number {
  const row = progress.snapshot().phases.flatMap((phase) => phase.agents).find((agent) => agent.label === label);
  assert.ok(row, `no progress row for ${label}`);
  return row.id;
}

function rowStatuses(progress: ProgressTracker): [string, string][] {
  return progress.snapshot().phases.flatMap((phase) => phase.agents.map((agent): [string, string] => [agent.label, agent.status]));
}

/** Sessions answer at once, except a `WORK_UNTIL_SKIPPED` prompt, which spends tokens and then works until aborted. */
function workingSessions(onWorking: () => void): CreateAgentSession {
  return async () => {
    const { session } = createTextSession();
    let messages: AssistantMessage[] = [];
    let release = () => {};
    return {
      session: {
        ...session,
        get messages() {
          return messages;
        },
        async prompt(text: string) {
          const turn = assistantTextMessage("partial");
          messages = [{ ...turn, usage: { ...turn.usage, output: SPENT_OUTPUT_TOKENS, totalTokens: SPENT_OUTPUT_TOKENS } }];
          if (text !== WORK_UNTIL_SKIPPED) return;
          await new Promise<void>((resolve) => {
            release = resolve;
            onWorking();
          });
        },
        async abort() {
          release();
        },
      },
    };
  };
}

function recordingJournal(recorded: unknown[]): WorkflowJournal {
  return {
    lookup: () => ({ hit: false }),
    async record(_key, value) {
      recorded.push(value);
      return { ok: true };
    },
  };
}

test("skipping a running agent from its progress row leaves a null parallel slot and spares the run and its siblings", async () => {
  const progress = tracker();
  const run = new AbortController();
  let accepted = false;
  const rc = createRunContext({
    createSession: workingSessions(() => {
      accepted = progress.skipAgent(rowId(progress, "slow"));
    }),
    progress,
    semaphore: new Semaphore(2),
    signal: run.signal,
  });

  const results = await parallel([
    () => runAgent(rc, WORK_UNTIL_SKIPPED, { label: "slow" }),
    () => runAgent(rc, "answer now", { label: "fast" }),
  ], { signal: run.signal, abortController: run });

  assert.equal(accepted, true);
  assert.deepEqual(results, [null, "done"]);
  assert.equal(run.signal.aborted, false);
  assert.deepEqual(rowStatuses(progress), [["slow", "skipped"], ["fast", "done"]]);
  assert.ok(progress.snapshot().logs.includes("slow skipped"));
  assert.equal(progress.skipAgent(rowId(progress, "fast")), false, "a finished agent cannot be skipped");
});

test("a directly awaited skipped agent rejects without an agentRetries restart and keeps its spent usage", async () => {
  const progress = tracker();
  const usage = createWorkflowUsageRecorder();
  const delays: number[] = [];
  let sessionsCreated = 0;
  const sessions = workingSessions(() => progress.skipAgent(rowId(progress, "slow")));
  const rc = createRunContext({
    createSession: async (options) => {
      sessionsCreated++;
      return await sessions(options);
    },
    progress,
    usage,
    agentRetries: 2,
    retryScheduler: {
      async sleep(delayMs) {
        delays.push(delayMs);
      },
    },
  });

  await assert.rejects(
    () => runAgent(rc, WORK_UNTIL_SKIPPED, { label: "slow" }),
    (error: unknown) => error instanceof WorkflowAgentSkippedError && error.code === "WORKFLOW_AGENT_SKIPPED" && error.label === "slow",
  );
  assert.equal(sessionsCreated, 1);
  assert.deepEqual(delays, []);
  assert.equal(usage.snapshot().totals.output, SPENT_OUTPUT_TOKENS);
});

test("a skip that lands as the attempt finishes still rejects and records no replay entry", async () => {
  for (const resume of [{ resume: "read-only", resumeInputs: [] }, { resume: "off" }] as const) {
    const progress = tracker();
    const recorded: unknown[] = [];
    const rc = createRunContext({
      // The attempt disposes its session after the prompt resolved and before settlement, so the skip lands in that window.
      createSession: async () => {
        const { session } = createTextSession();
        return { session: { ...session, dispose: () => void progress.skipAgent(rowId(progress, "late")) } };
      },
      progress,
      journal: recordingJournal(recorded),
    });

    await assert.rejects(() => runAgent(rc, "answer now", { label: "late", ...resume }), WorkflowAgentSkippedError, resume.resume);
    assert.deepEqual(recorded, [], resume.resume);
    assert.deepEqual(rowStatuses(progress), [["late", "skipped"]], resume.resume);
  }
});
