import type { Skill } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { captureAgentSkillIdentities, extractSkillSelectorsFromText } from "./agent-skills.ts";
import type { AgentExecutionOptions, AgentRunnerSession, AgentRunTags, RunContext } from "./agent-runner-types.ts";
import { captureEffectiveSession, FINAL_TOOL } from "./agent-session.ts";
import type { AgentWorkspace, IsolatedAgentWorkspace } from "./agent-workspace.ts";
import { captureAgentJournalKey } from "./journal.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import {
  captureRepositoryMutationGuard,
  captureIsolatedRepositoryContext,
  captureRepositoryResumeContext,
  createAgentResumeContext,
  resumeContextMismatchReason,
  type AgentResumeBaseContext,
  type AgentResumeContext,
  type RepositoryResumeContext,
  type VerifiedRepositoryResumeContext,
  type VerifiedWorkflowResumeContext,
} from "./resume-context.ts";

export type AgentReplayPlan =
  | { readonly kind: "off" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "shared"; readonly key: string; readonly additionalInputs: readonly string[] }
  | { readonly kind: "isolated"; readonly key: string };

export type AgentReplayEvidence =
  | { readonly kind: "shared" }
  | { readonly kind: "isolated"; readonly mutationGuard: string };

export type AgentAttemptResult =
  | { readonly kind: "cache-hit"; readonly result: unknown; readonly identity: AgentResumeContext; readonly evidence: AgentReplayEvidence }
  | { readonly kind: "live-recordable"; readonly result: unknown; readonly identity: AgentResumeContext; readonly evidence: AgentReplayEvidence }
  | { readonly kind: "live-unrecordable"; readonly result: unknown };

export type AgentAttemptSettlement =
  | { readonly kind: "done"; readonly result: unknown }
  | { readonly kind: "retry-live" };

type ReplayIdentityCapture =
  | { readonly kind: "verified"; readonly identity: AgentResumeContext }
  | { readonly kind: "unverifiable"; readonly reason: string };

const INACCESSIBLE_REPOSITORY_CONTEXT: VerifiedRepositoryResumeContext = {
  kind: "verified",
  state: "inaccessible",
  workingTreeFingerprint: "no-workspace-capability",
};

export function createAgentReplayPlan(
  prompt: string,
  opts: AgentExecutionOptions,
): AgentReplayPlan {
  if (opts.resume !== undefined && opts.resume !== "read-only" && opts.resume !== "off") {
    return { kind: "disabled", reason: "resume policy must be read-only or off" };
  }
  const isolated = opts.isolation === "worktree";
  if (opts.resume === "off" || (!isolated && opts.resume !== "read-only")) return { kind: "off" };
  const additionalInputs = inspectResumeInputs(opts);
  if (typeof additionalInputs === "string") return { kind: "disabled", reason: additionalInputs };
  const capture = captureAgentJournalKey(prompt, opts, opts.worktreeBaseline);
  if (capture.kind === "unverifiable") return { kind: "disabled", reason: capture.reason };
  return isolated
    ? { kind: "isolated", key: capture.key }
    : { kind: "shared", key: capture.key, additionalInputs };
}

export function isReplayEnabled(
  replay: AgentReplayPlan,
): replay is Extract<AgentReplayPlan, { readonly kind: "shared" | "isolated" }> {
  return replay.kind === "shared" || replay.kind === "isolated";
}

export async function captureSharedRepositoryBeforeSetup(
  rc: RunContext,
  prompt: string,
  opts: AgentExecutionOptions,
  replay: Extract<AgentReplayPlan, { readonly kind: "shared" }>,
): Promise<RepositoryResumeContext> {
  if (declaresNoWorkspaceCapability(prompt, opts)) return INACCESSIBLE_REPOSITORY_CONTEXT;
  return await captureRepositoryResumeContext(rc.cwd, replay.additionalInputs, rc.signal);
}

export async function captureIsolatedRepositoryAfterSetup(
  rc: RunContext,
  prompt: string,
  opts: AgentExecutionOptions,
  workspace: IsolatedAgentWorkspace,
): Promise<RepositoryResumeContext> {
  if (declaresNoWorkspaceCapability(prompt, opts)) return INACCESSIBLE_REPOSITORY_CONTEXT;
  return await captureIsolatedRepositoryContext(workspace.cwd, workspace.baselineOid, rc.signal);
}

export async function captureReplayIdentity(input: {
  readonly rc: RunContext;
  readonly base: AgentResumeBaseContext;
  readonly repository: RepositoryResumeContext;
  readonly selectedSkills: readonly Skill[];
  readonly session: AgentRunnerSession;
  readonly sessionCwd: string;
}): Promise<ReplayIdentityCapture> {
  if (input.repository.kind === "unverifiable") return input.repository;
  if (input.base.workflow.kind === "unverifiable") return input.base.workflow;
  return await captureVerifiedReplayIdentity({
    ...input,
    repository: input.repository,
    workflow: input.base.workflow,
  });
}

export async function lookupReplayResult(input: {
  readonly rc: RunContext;
  readonly key: string;
  readonly identity: AgentResumeContext;
  readonly opts: AgentExecutionOptions;
  readonly workspace: AgentWorkspace;
}): Promise<{ readonly hit: true; readonly result: unknown } | { readonly hit: false; readonly reason?: string }> {
  const cached = input.rc.journal.lookup(input.key, input.identity);
  if (!cached.hit) return cached;
  const validation = await validateCachedResult(cached.value, input.opts, input.rc, input.workspace);
  return validation.ok
    ? { hit: true, result: cached.value }
    : { hit: false, reason: validation.reason };
}

export async function validateReplayIdentity(input: {
  readonly rc: RunContext;
  readonly identity: AgentResumeContext;
  readonly selectedSkills: readonly Skill[];
  readonly session: AgentRunnerSession;
  readonly sessionCwd: string;
  readonly replay: Extract<AgentReplayPlan, { readonly kind: "shared" | "isolated" }>;
  readonly workspace: AgentWorkspace;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const repository = input.identity.repository.state === "inaccessible"
    ? INACCESSIBLE_REPOSITORY_CONTEXT
    : await captureCurrentRepository(input.rc, input.replay, input.workspace);
  if (repository.kind === "unverifiable") return { ok: false, reason: repository.reason };

  const current = await captureVerifiedReplayIdentity({
    rc: input.rc,
    repository,
    workflow: input.identity.workflow,
    selectedSkills: input.selectedSkills,
    session: input.session,
    sessionCwd: input.sessionCwd,
  });
  if (current.kind === "unverifiable") return { ok: false, reason: current.reason };
  const mismatch = resumeContextMismatchReason(input.identity, current.identity);
  return mismatch ? { ok: false, reason: mismatch } : { ok: true };
}

export async function settleAgentAttempt(input: {
  readonly rc: RunContext;
  readonly label: string;
  readonly tags: AgentRunTags;
  readonly replay: AgentReplayPlan;
  readonly outcome: AgentAttemptResult;
}): Promise<AgentAttemptSettlement> {
  const { rc, label, replay, outcome } = input;
  if (outcome.kind === "live-unrecordable") {
    return { kind: "done", result: outcome.result };
  }
  if (!isReplayEnabled(replay)) throw new Error("Replayable agent outcome produced without an enabled replay plan.");

  const repository = await validateRepositoryAfterCleanup(
    rc,
    outcome.identity,
    replay,
    outcome.evidence,
  );
  if (!repository.ok) {
    if (outcome.kind === "cache-hit") {
      rc.progress.log(`${label}: cached result invalidated after cleanup (${repository.reason})`);
      return { kind: "retry-live" };
    }
    rc.progress.log(`${label}: read-only resume contract was not recorded (${repository.reason})`);
    return { kind: "done", result: outcome.result };
  }

  await recordJournalResult(rc, label, replay.key, outcome.result, outcome.identity);
  if (outcome.kind === "cache-hit") {
    rc.progress.log(`${label}: using cached result from workflow journal`);
    rc.perf.counter("agent.cache_hit", 1, input.tags);
  }
  return { kind: "done", result: outcome.result };
}

async function captureVerifiedReplayIdentity(input: {
  readonly rc: RunContext;
  readonly repository: VerifiedRepositoryResumeContext;
  readonly workflow: VerifiedWorkflowResumeContext;
  readonly selectedSkills: readonly Skill[];
  readonly session: AgentRunnerSession;
  readonly sessionCwd: string;
}): Promise<ReplayIdentityCapture> {
  const [skills, effectiveSession] = await Promise.all([
    captureAgentSkillIdentities(input.selectedSkills, {
      sessionCwd: input.sessionCwd,
      workspaceRoot: input.rc.cwd,
      signal: input.rc.signal,
    }),
    captureEffectiveSession(input.session, input.sessionCwd, input.rc.cwd, input.rc.signal),
  ]);
  if (skills.kind === "unverifiable") return skills;
  if (effectiveSession.kind === "unverifiable") return effectiveSession;
  if (
    input.repository.state === "inaccessible" &&
    (skills.skills.length > 0 || effectiveSession.identity.tools.some((tool) => tool.name !== FINAL_TOOL))
  ) {
    return { kind: "unverifiable", reason: "session unexpectedly retained workspace-observing capabilities" };
  }
  return {
    kind: "verified",
    identity: createAgentResumeContext(
      { workflow: input.workflow },
      input.repository,
      effectiveSession.identity,
      skills.skills,
    ),
  };
}

async function validateCachedResult(
  value: unknown,
  opts: AgentExecutionOptions,
  rc: RunContext,
  workspace: AgentWorkspace,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  let result: unknown;
  if (opts.isolation === "worktree") {
    const isolated = isolatedCachedResult(value);
    if (!isolated.ok) return isolated;
    const patch = await rc.worktrees.validatePatch(workspace.cwd, isolated.wrapper, rc.signal);
    if (!patch.ok) {
      return {
        ok: false,
        reason: `cached isolated patch does not apply to the current baseline (${(patch.error ?? patch.stderr.trim()) || "unknown error"})`,
      };
    }
    result = isolated.value;
  } else {
    result = value;
  }
  if (!opts.schema) {
    return typeof result === "string"
      ? { ok: true }
      : { ok: false, reason: "cached text result is not a string" };
  }
  if (result === null) return { ok: true };
  try {
    return Value.Check(opts.schema, result)
      ? { ok: true }
      : { ok: false, reason: "cached structured result does not match the current schema" };
  } catch (error) {
    return { ok: false, reason: `cached structured result could not be validated (${unknownErrorMessage(error)})` };
  }
}

function isolatedCachedResult(value: unknown):
  | {
      readonly ok: true;
      readonly value: unknown;
      readonly wrapper: { readonly result: unknown; readonly patch: string; readonly changed: boolean };
    }
  | { readonly ok: false; readonly reason: string } {
  if (typeof value !== "object" || value === null) {
    return { ok: false, reason: "cached isolated result is not an object" };
  }
  const candidate = value as { readonly result?: unknown; readonly patch?: unknown; readonly changed?: unknown };
  if (!("result" in candidate) || typeof candidate.patch !== "string" || typeof candidate.changed !== "boolean") {
    return { ok: false, reason: "cached isolated result has an invalid wrapper" };
  }
  const wrapper = { result: candidate.result, patch: candidate.patch, changed: candidate.changed };
  return { ok: true, value: wrapper.result, wrapper };
}

async function validateRepositoryAfterCleanup(
  rc: RunContext,
  identity: AgentResumeContext,
  replay: Extract<AgentReplayPlan, { readonly kind: "shared" | "isolated" }>,
  evidence: AgentReplayEvidence,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  if (replay.kind === "isolated") {
    return evidence.kind === "isolated"
      ? await validateReplayEvidence(rc, evidence)
      : { ok: false, reason: "isolated replay omitted its main-workspace mutation guard" };
  }

  const repository = identity.repository.state === "inaccessible"
    ? INACCESSIBLE_REPOSITORY_CONTEXT
    : await captureRepositoryResumeContext(rc.cwd, replay.additionalInputs, rc.signal);
  if (repository.kind === "unverifiable") return { ok: false, reason: repository.reason };
  const mismatch = resumeContextMismatchReason(identity, { ...identity, repository });
  if (mismatch) return { ok: false, reason: mismatch };
  return evidence.kind === "shared"
    ? { ok: true }
    : { ok: false, reason: "shared replay carried isolated mutation evidence" };
}

export async function validateReplayEvidence(
  rc: RunContext,
  evidence: AgentReplayEvidence,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  return evidence.kind === "shared"
    ? { ok: true }
    : await validateRepositoryMutationGuard(rc, evidence.mutationGuard);
}

export async function validateRepositoryMutationGuard(
  rc: RunContext,
  expected: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const current = await captureRepositoryMutationGuard(rc.cwd, rc.signal);
  if (current.kind === "unverifiable") return { ok: false, reason: current.reason };
  return current.fingerprint === expected
    ? { ok: true }
    : { ok: false, reason: "main workspace changed outside the isolated worktree" };
}

async function captureCurrentRepository(
  rc: RunContext,
  replay: Extract<AgentReplayPlan, { readonly kind: "shared" | "isolated" }>,
  workspace: AgentWorkspace,
): Promise<RepositoryResumeContext> {
  if (replay.kind === "shared") return await captureRepositoryResumeContext(rc.cwd, replay.additionalInputs, rc.signal);
  if (workspace.kind !== "isolated") {
    return { kind: "unverifiable", reason: "isolated replay lost its isolated workspace baseline" };
  }
  return await captureIsolatedRepositoryContext(workspace.cwd, workspace.baselineOid, rc.signal);
}

async function recordJournalResult(
  rc: RunContext,
  label: string,
  key: string,
  result: unknown,
  identity: AgentResumeContext,
): Promise<void> {
  try {
    const recorded = await rc.journal.record(key, result, identity);
    if (!recorded.ok) {
      rc.progress.log(`${label}: workflow journal write failed (${recorded.error}); future resume may be incomplete`);
    }
  } catch (error) {
    rc.progress.log(`${label}: workflow journal write failed (${unknownErrorMessage(error)}); future resume may be incomplete`);
  }
}

function declaresNoWorkspaceCapability(prompt: string, opts: AgentExecutionOptions): boolean {
  return (
    opts.tools !== undefined &&
    opts.tools.length === 0 &&
    (opts.toolHints?.length ?? 0) === 0 &&
    (opts.skills?.length ?? 0) === 0 &&
    extractSkillSelectorsFromText(prompt).length === 0
  );
}

function inspectResumeInputs(opts: AgentExecutionOptions): readonly string[] | string {
  try {
    const inputs = opts.resumeInputs;
    if (inputs === undefined) return [];
    if (!Array.isArray(inputs)) return "read-only resume inputs must be an array";
    if (inputs.length > 128) return "read-only resume accepts at most 128 repository inputs";
    const inspected: string[] = [];
    for (let index = 0; index < inputs.length; index++) {
      const value = inputs[index];
      if (typeof value !== "string") return "read-only resume inputs must be strings";
      inspected.push(value);
    }
    return inspected;
  } catch {
    return "read-only resume inputs could not be inspected";
  }
}
