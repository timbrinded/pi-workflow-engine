import { assertWorkflowBudgetAvailable } from "./budget.ts";
import { WorkflowAgentTimeoutError } from "./agent-limits.ts";
import { abortReason, linkAbortSignal, throwIfAborted } from "./cancellation.ts";
import { executeAgentAttempt } from "./agent-attempt.ts";
import {
  createAgentReplayPlan,
  isReplayEnabled,
  settleAgentAttempt,
  type AgentAttemptResult,
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
import {
  agentRetryDelayMs,
  WorkflowProviderError,
} from "./agent-retry.ts";
import { resolveAgentModelProfile } from "./model-profiles.ts";

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
 * modules; this boundary owns admission, progress, and bounded cache/provider retries.
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
    const routing = resolveAgentRouting(rc, opts, label);
    const effectiveOpts = routing.thinkingLevel === opts.thinkingLevel
      ? opts
      : { ...opts, thinkingLevel: routing.thinkingLevel };
    const replay = createAgentReplayPlan(prompt, effectiveOpts);
    if (!isReplayEnabled(replay)) assertWorkflowBudgetAvailable(rc.budget);

    const rowId = rc.progress.agentQueued(opts.phase, label);
    const liveScope = createAgentLiveScope(rc, label);
    try {
      return await rc.semaphore.run(
        async () => {
          const agentRc: RunContext = { ...rc, signal: liveScope.signal };
          throwIfAborted(agentRc.signal);
          if (!isReplayEnabled(replay)) assertWorkflowBudgetAvailable(agentRc.budget);
          rc.progress.agentStart(opts.phase, label, rowId);
          if (replay.kind === "disabled") {
            rc.progress.log(`${label}: resume disabled for this call (${replay.reason})`);
          }

          let attemptPlan: AgentReplayPlan = replay;
          let providerRetries = 0;
          while (true) {
            let outcome: AgentAttemptResult;
            try {
              outcome = await executeAgentAttempt({
                rc: agentRc,
                prompt,
                opts: effectiveOpts,
                resumeBaseContext,
                model: routing.model,
                replay: attemptPlan,
                label,
                rowId,
                tags,
                admitLiveAgent: liveScope.admit,
              });
            } catch (error) {
              if (!(error instanceof WorkflowProviderError) || !error.retryable) throw error;
              if (providerRetries >= agentRc.agentRetries) {
                if (agentRc.agentRetries > 0) {
                  rc.progress.log(`${label}: transient provider failure after ${providerRetries} retries; giving up`);
                }
                throw error;
              }

              assertWorkflowBudgetAvailable(agentRc.budget);
              providerRetries++;
              const delayMs = agentRetryDelayMs(providerRetries);
              rc.progress.log(`${label}: transient provider failure; retry ${providerRetries}/${agentRc.agentRetries} in ${delayMs}ms`);
              rc.perf.counter("agent.provider_retry", 1, tags);
              rc.perf.observe("agent.provider_retry_delay_ms", delayMs, tags);
              attemptPlan = { kind: "off" };
              await agentRc.retryScheduler.sleep(delayMs, agentRc.signal);
              continue;
            }
            const settlement = await settleAgentAttempt({ rc: agentRc, label, tags, replay: attemptPlan, outcome });
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
      let failure = error;
      if (liveScope.signal.aborted) failure = abortReason(liveScope.signal);
      if (rc.signal?.aborted) failure = abortReason(rc.signal);
      rc.progress.agentFailed(label, failure, rowId);
      rc.progress.log(`${label} failed: ${unknownErrorMessage(failure)}`);
      throw failure;
    } finally {
      liveScope.dispose();
    }
  }, tags);
}

function createAgentLiveScope(rc: RunContext, label: string) {
  const controller = new AbortController();
  const unlink = linkAbortSignal(rc.signal, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerStarted = false;

  return {
    signal: controller.signal,
    admit() {
      rc.agentLimiter.admit(controller.signal);
      if (timerStarted) return;
      timerStarted = true;
      timer = setTimeout(
        () => controller.abort(new WorkflowAgentTimeoutError(label, rc.agentTimeoutMs)),
        rc.agentTimeoutMs,
      );
    },
    dispose() {
      if (timer) clearTimeout(timer);
      unlink();
    },
  };
}

function resolveAgentRouting(
  rc: RunContext,
  opts: AgentExecutionOptions,
  label: string,
): { readonly model: ResolvedAgentModel["model"]; readonly thinkingLevel: AgentExecutionOptions["thinkingLevel"] } {
  try {
    return resolveAgentModelProfile(
      {
        request: opts,
        profiles: rc.modelProfiles,
        resolveExplicitModel: (modelRef) => resolveAgentModel(modelRef, rc.modelRegistry, rc.hostModel).model,
        hostModel: rc.hostModel,
      },
    );
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
