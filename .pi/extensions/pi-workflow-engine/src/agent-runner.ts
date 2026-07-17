import { assertWorkflowBudgetAvailable } from "./budget.ts";
import { throwIfAborted } from "./cancellation.ts";
import { executeAgentAttempt } from "./agent-attempt.ts";
import {
  createAgentReplayPlan,
  isReplayEnabled,
  settleAgentAttempt,
  type AgentReplayPlan,
} from "./agent-replay.ts";
import {
  resolveAgentModel,
  type ResolvedAgentModel,
} from "./agent-session.ts";
import type {
  AgentExecutionOptions,
  AgentRunTags,
  RunContext,
} from "./agent-runner-types.ts";
import type { AgentResumeBaseContext } from "./resume-context.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export type {
  AgentExecutionOptions,
  AgentProgress,
  AgentRunnerEvent,
  AgentRunnerSession,
  AgentRunnerToolInfo,
  CreateAgentSession,
  RunContext,
} from "./agent-runner-types.ts";
export { resolveAgentModel } from "./agent-session.ts";
export type { ResolvedAgentModel, ResolvedAgentModelRequest } from "./agent-session.ts";

/**
 * Run one subagent to completion in an isolated in-memory session.
 *
 * Session construction, replay validation, and workspace cleanup live in focused
 * modules; this boundary owns only admission, progress, and the one cache-to-live retry.
 */
export async function runAgent(
  rc: RunContext,
  prompt: string,
  opts: AgentExecutionOptions,
  resumeBaseContext: AgentResumeBaseContext,
): Promise<unknown> {
  if (typeof prompt !== "string") {
    throw new Error(`agent() prompt must be a string; received ${describeAgentPrompt(prompt)}`);
  }

  const label = opts.label ?? "agent";
  const phase = opts.phase ?? "Workflow";
  const tags: AgentRunTags = { label, phase };

  return await rc.perf.time("agent.total_ms", async () => {
    throwIfAborted(rc.signal);
    const model = resolveModel(rc, opts, label);
    const replay = createAgentReplayPlan(prompt, opts);
    if (!isReplayEnabled(replay)) assertWorkflowBudgetAvailable(rc.budget);

    const rowId = rc.progress.agentQueued(opts.phase, label);
    try {
      return await rc.semaphore.run(
        async () => {
          throwIfAborted(rc.signal);
          if (!isReplayEnabled(replay)) assertWorkflowBudgetAvailable(rc.budget);
          rc.progress.agentStart(opts.phase, label, rowId);
          if (replay.kind === "disabled") {
            rc.progress.log(`${label}: resume disabled for this call (${replay.reason})`);
          }

          let attemptPlan: AgentReplayPlan = replay;
          while (true) {
            const outcome = await executeAgentAttempt({
              rc,
              prompt,
              opts,
              resumeBaseContext,
              model,
              replay: attemptPlan,
              label,
              rowId,
              tags,
            });
            const settlement = await settleAgentAttempt({ rc, label, tags, replay: attemptPlan, outcome });
            if (settlement.kind === "retry-live") {
              attemptPlan = { kind: "off" };
              continue;
            }
            rc.progress.agentDone(label, rowId);
            return settlement.result;
          }
        },
        {
          onQueueWaitMs: (durationMs) => rc.perf.observe("agent.queue_wait_ms", durationMs, tags),
          signal: rc.signal,
        },
      );
    } catch (error) {
      rc.progress.agentFailed(label, error, rowId);
      rc.progress.log(`${label} failed: ${unknownErrorMessage(error)}`);
      throw error;
    }
  }, tags);
}

function resolveModel(
  rc: RunContext,
  opts: AgentExecutionOptions,
  label: string,
): ResolvedAgentModel["model"] {
  try {
    return resolveAgentModel(opts.model, rc.modelRegistry, rc.hostModel).model;
  } catch (error) {
    rc.progress.agentFailed(label, error);
    throw error;
  }
}

function describeAgentPrompt(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
