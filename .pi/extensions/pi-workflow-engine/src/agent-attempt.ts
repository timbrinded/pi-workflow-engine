import type { Api, Model } from "@earendil-works/pi-ai";
import { assertWorkflowBudgetAvailable } from "./budget.ts";
import {
  type AgentExecutionOptions,
  type RunContext,
} from "./agent-runner-types.ts";
import {
  captureReplayIdentity,
  captureIsolatedRepositoryAfterSetup,
  captureSharedRepositoryBeforeSetup,
  lookupReplayResult,
  validateMutationGuard,
  validateReplayIdentity,
  type AgentAttemptResult,
  type AgentReplayContract,
  type AgentReplayPlan,
  type ArmedReplayPlan,
} from "./agent-replay.ts";
import { openAgentSession, promptAgentSession, type AgentSessionHandle } from "./agent-session.ts";
import { createAgentWorkspace, type AgentWorkspace } from "./agent-workspace.ts";
import type { AgentResumeBaseContext, RepositoryResumeContext } from "./resume-context.ts";
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
  readonly phase: string;
  readonly admitLiveAgent: () => void;
}): Promise<AgentAttemptResult> {
  const { rc, prompt, opts, resumeBaseContext, model, replay, label, rowId, phase, admitLiveAgent } = input;
  let armed: ArmedReplayPlan | undefined;
  let repositoryBefore: RepositoryResumeContext | undefined;
  if (replay.kind === "isolated") {
    const mutationGuard = await captureRepositoryMutationGuard(rc.cwd, rc.signal);
    if (mutationGuard.kind === "verified") armed = { ...replay, mutationGuard: mutationGuard.fingerprint };
  } else if (replay.kind === "shared") {
    armed = replay;
    repositoryBefore = await captureSharedRepositoryBeforeSetup(rc, prompt, opts, replay);
  }
  let workspace: AgentWorkspace | undefined;
  let handle: AgentSessionHandle | undefined;

  try {
    workspace = await createAgentWorkspace(rc, opts, label);
    if (armed?.kind === "isolated") {
      if (workspace.kind !== "isolated") throw new Error("Isolated replay created a shared workspace.");
      repositoryBefore = await captureIsolatedRepositoryAfterSetup(rc, prompt, opts, workspace);
    }
    handle = await openAgentSession({ rc, prompt, opts, cwd: workspace.cwd, model, label });

    let contract: AgentReplayContract | undefined;
    if (armed && repositoryBefore) {
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
        contract = { ...armed, identity: capture.identity };
        const cached = await lookupReplayResult({ rc, key: contract.key, identity: contract.identity, opts, workspace });
        if (cached.hit) {
          const validation = await validateReplayContract(rc, contract, handle, workspace);
          if (validation.ok) {
            return { kind: "cache-hit", result: cached.result, contract };
          }
          rc.progress.log(`${label}: cached result invalidated (${validation.reason})`);
        } else if (cached.reason) {
          rc.progress.log(`${label}: cached result invalidated (${cached.reason})`);
        }
      }
    }

    assertWorkflowBudgetAvailable(rc.budget);
    admitLiveAgent();
    const rawResult = await promptAgentSession({
      rc,
      handle,
      prompt,
      opts,
      label,
      rowId,
      phase,
    });
    const result = await workspace.wrapResult(rawResult);
    if (!contract) return { kind: "live-unrecordable", result };

    const validation = await validateReplayContract(rc, contract, handle, workspace);
    if (validation.ok) {
      return { kind: "live-recordable", result, contract };
    }
    rc.progress.log(`${label}: read-only resume contract was not recorded (${validation.reason})`);
    return { kind: "live-unrecordable", result };
  } finally {
    try {
      const session = handle?.session;
      if (session) rc.perf.timeSync("agent.dispose_ms", () => session.dispose());
    } finally {
      await workspace?.dispose();
    }
  }
}

/** Re-check a captured replay identity and its repository evidence against the session and workspace as they are now. */
async function validateReplayContract(
  rc: RunContext,
  contract: AgentReplayContract,
  handle: AgentSessionHandle,
  workspace: AgentWorkspace,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const identity = await validateReplayIdentity({
    rc,
    contract,
    selectedSkills: handle.selectedSkills,
    session: handle.session,
    sessionCwd: workspace.cwd,
    workspace,
  });
  if (!identity.ok || contract.kind === "shared") return identity;
  return await validateMutationGuard(rc, contract.mutationGuard);
}
