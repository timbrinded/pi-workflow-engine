import type { Api, Model } from "@earendil-works/pi-ai";
import { assertWorkflowBudgetAvailable } from "./budget.ts";
import {
  type AgentExecutionOptions,
  type AgentRunTags,
  type RunContext,
} from "./agent-runner-types.ts";
import {
  captureReplayIdentity,
  captureIsolatedRepositoryAfterSetup,
  captureSharedRepositoryBeforeSetup,
  isReplayEnabled,
  lookupReplayResult,
  validateReplayEvidence,
  validateReplayIdentity,
  type AgentAttemptResult,
  type AgentReplayEvidence,
  type AgentReplayPlan,
} from "./agent-replay.ts";
import { openAgentSession, promptAgentSession, type AgentSessionHandle } from "./agent-session.ts";
import {
  createAgentWorkspace,
  disposeAgentWorkspace,
  type AgentWorkspace,
} from "./agent-workspace.ts";
import type { AgentResumeBaseContext, AgentResumeContext, RepositoryResumeContext } from "./resume-context.ts";
import { captureRepositoryMutationGuard } from "./resume-context.ts";

/** Execute one fully bracketed workspace/session attempt. Cleanup always precedes settlement. */
export async function executeAgentAttempt(input: {
  readonly rc: RunContext;
  readonly prompt: string;
  readonly opts: AgentExecutionOptions;
  readonly resumeBaseContext: AgentResumeBaseContext;
  readonly model: Model<Api> | undefined;
  readonly replay: AgentReplayPlan;
  readonly label: string;
  readonly rowId: number;
  readonly tags: AgentRunTags;
}): Promise<AgentAttemptResult> {
  const { rc, prompt, opts, resumeBaseContext, model, replay, label, rowId, tags } = input;
  let repositoryBefore: RepositoryResumeContext | undefined;
  let evidence: AgentReplayEvidence | undefined;
  if (isReplayEnabled(replay)) {
    if (replay.kind === "isolated") {
      const mutationGuard = await captureRepositoryMutationGuard(rc.cwd, rc.signal);
      if (mutationGuard.kind === "unverifiable") {
        repositoryBefore = mutationGuard;
      } else {
        evidence = { kind: "isolated", mutationGuard: mutationGuard.fingerprint };
      }
    } else {
      repositoryBefore = await captureSharedRepositoryBeforeSetup(rc, prompt, opts, replay);
      evidence = { kind: "shared" };
    }
  }
  let workspace: AgentWorkspace | undefined;
  let handle: AgentSessionHandle | undefined;

  try {
    workspace = await createAgentWorkspace(rc, opts, label);
    if (replay.kind === "isolated" && evidence?.kind === "isolated") {
      if (workspace.kind !== "isolated") throw new Error("Isolated replay created a shared workspace.");
      repositoryBefore = await captureIsolatedRepositoryAfterSetup(rc, prompt, opts, workspace);
    }
    handle = await openAgentSession({ rc, prompt, opts, cwd: workspace.cwd, model, label, tags });

    let identity: AgentResumeContext | undefined;
    if (isReplayEnabled(replay) && repositoryBefore && evidence) {
      const capture = await captureReplayIdentity({
        rc,
        base: resumeBaseContext,
        repository: repositoryBefore,
        selectedSkills: handle.selectedSkills,
        session: handle.session,
        sessionCwd: workspace.cwd,
      });
      if (capture.kind === "unverifiable") {
        rc.progress.log(`${label}: resume disabled for this call (${capture.reason})`);
      } else {
        identity = capture.identity;
        const cached = await lookupReplayResult({ rc, key: replay.key, identity, opts, workspace });
        if (cached.hit) {
          const contract = await validateReplayIdentity({
            rc,
            identity,
            selectedSkills: handle.selectedSkills,
            session: handle.session,
            sessionCwd: workspace.cwd,
            replay,
            workspace,
          });
          const validation = contract.ok
            ? await validateReplayEvidence(rc, evidence)
            : contract;
          if (validation.ok) {
            return { kind: "cache-hit", result: cached.result, identity, evidence };
          }
          rc.progress.log(`${label}: cached result invalidated (${validation.reason})`);
        } else if (cached.reason) {
          rc.progress.log(`${label}: cached result invalidated (${cached.reason})`);
        }
      }
    }

    assertWorkflowBudgetAvailable(rc.budget);
    const rawResult = await promptAgentSession({
      rc,
      handle,
      prompt,
      opts,
      label,
      rowId,
      tags,
    });
    const result = await workspace.wrapResult(rawResult);
    if (!identity) return { kind: "live-unrecordable", result };
    if (!isReplayEnabled(replay) || !evidence) throw new Error("Replay identity produced without complete replay evidence.");

    const contract = await validateReplayIdentity({
      rc,
      identity,
      selectedSkills: handle.selectedSkills,
      session: handle.session,
      sessionCwd: workspace.cwd,
      replay,
      workspace,
    });
    const validation = contract.ok
      ? await validateReplayEvidence(rc, evidence)
      : contract;
    if (validation.ok) {
      return { kind: "live-recordable", result, identity, evidence };
    }
    rc.progress.log(`${label}: read-only resume contract was not recorded (${validation.reason})`);
    return { kind: "live-unrecordable", result };
  } finally {
    try {
      const session = handle?.session;
      if (session) rc.perf.timeSync("agent.dispose_ms", () => session.dispose(), tags);
    } finally {
      await disposeAgentWorkspace(rc, label, workspace);
    }
  }
}
