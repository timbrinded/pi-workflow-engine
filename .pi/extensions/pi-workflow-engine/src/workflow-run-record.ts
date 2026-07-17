import { validateWorkflowRunId } from "./journal.ts";
import type { ResolvedWorkflowRunOptions } from "./options.ts";
import type { WorkflowProgressSnapshot } from "./progress-types.ts";
import type { LoadedWorkflow, WorkflowSourceIdentity } from "./types.ts";
import { isWorkflowUsageSnapshot, type WorkflowUsageSnapshot } from "./usage.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export const WORKFLOW_RUN_RECORD_VERSION = 1;

const MAX_RESULT_BYTES = 1 << 20;
const MAX_RESULT_DEPTH = 64;
const MAX_RESULT_NODES = 16_384;
const MAX_PERSISTED_AGENTS = 1_000;
const MAX_PERSISTED_COUNTERS = 200;
const MAX_PERSISTED_LANES = 50;
const MAX_PERSISTED_LANE_ITEMS = 200;
const MAX_PERSISTED_PHASES = 200;
const MAX_PERSISTED_SUMMARY_ENTRIES = 200;
const MAX_PERSISTED_TEXT = 2_048;
const MAX_PERSISTED_USAGE_AGENTS = 1_000;
const REDACTED = "[redacted]";

export type WorkflowRunState = "queued" | "running" | "completed" | "failed" | "stopped" | "paused";

export type WorkflowRunStoredValue =
  | null
  | boolean
  | number
  | string
  | readonly WorkflowRunStoredValue[]
  | { readonly [key: string]: WorkflowRunStoredValue };

export type WorkflowRunStoredResult =
  | { readonly kind: "value"; readonly value: WorkflowRunStoredValue }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface PersistedWorkflowRunOptions {
  readonly inspect: boolean;
  readonly perf: boolean;
  readonly concurrency: number;
  readonly parallelSubmissionLimit: number | null;
  readonly maxAgents: number;
  readonly agentTimeoutMs: number;
  readonly agentRetries: number;
  readonly budget: number | null;
  readonly resultViewer?: "open" | "skip";
  readonly resumeFromRunId?: string;
}

export interface PersistedWorkflowIdentity {
  readonly name: string;
  readonly sourceKind: WorkflowSourceIdentity["kind"];
  readonly sourceFingerprint?: string;
}

interface WorkflowRunRecordBase {
  readonly version: typeof WORKFLOW_RUN_RECORD_VERSION;
  readonly runId: string;
  readonly workflow: PersistedWorkflowIdentity;
  readonly journalFile: string;
  readonly options: PersistedWorkflowRunOptions;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly progress: WorkflowProgressSnapshot;
  readonly usage?: WorkflowUsageSnapshot;
}

export type WorkflowRunRecord = WorkflowRunRecordBase & (
  | { readonly state: "queued"; readonly startedAt?: number; readonly endedAt?: never; readonly result?: never; readonly message?: never }
  | { readonly state: "running"; readonly startedAt: number; readonly endedAt?: never; readonly result?: never; readonly message?: never }
  | { readonly state: "paused"; readonly startedAt: number; readonly endedAt?: never; readonly result?: never; readonly message: string }
  | { readonly state: "completed"; readonly startedAt: number; readonly endedAt: number; readonly usage: WorkflowUsageSnapshot; readonly result: WorkflowRunStoredResult; readonly message?: never }
  | { readonly state: "failed" | "stopped"; readonly startedAt: number; readonly endedAt: number; readonly usage: WorkflowUsageSnapshot; readonly result?: never; readonly message: string }
);

export type WorkflowRunTransition =
  | { readonly state: "queued"; readonly progress: WorkflowProgressSnapshot; readonly at?: number }
  | { readonly state: "running"; readonly progress: WorkflowProgressSnapshot; readonly at?: number }
  | { readonly state: "paused"; readonly progress: WorkflowProgressSnapshot; readonly message: string; readonly at?: number }
  | { readonly state: "completed"; readonly progress: WorkflowProgressSnapshot; readonly usage: WorkflowUsageSnapshot; readonly result: unknown; readonly at?: number }
  | { readonly state: "failed" | "stopped"; readonly progress: WorkflowProgressSnapshot; readonly usage: WorkflowUsageSnapshot; readonly error: unknown; readonly at?: number };

export function createWorkflowRunRecord(input: {
  readonly runId: string;
  readonly workflow: LoadedWorkflow;
  readonly options: ResolvedWorkflowRunOptions;
  readonly progress: WorkflowProgressSnapshot;
}): WorkflowRunRecord {
  const runId = validateWorkflowRunId(input.runId);
  assertMatchingRun(runId, input.progress.runId);
  return {
    version: WORKFLOW_RUN_RECORD_VERSION,
    runId,
    state: "queued",
    workflow: persistedWorkflowIdentity(input.workflow),
    journalFile: `${runId}.jsonl`,
    options: persistedWorkflowRunOptions(input.options),
    createdAt: input.progress.startedAt,
    updatedAt: input.progress.startedAt,
    progress: compactWorkflowProgress(input.progress),
  };
}

export function updateWorkflowRunProgress(
  record: WorkflowRunRecord,
  progress: WorkflowProgressSnapshot,
  at = Date.now(),
): WorkflowRunRecord {
  assertMatchingRun(record.runId, progress.runId);
  const compact = compactWorkflowProgress(progress);
  const updated = {
    ...record,
    updatedAt: at,
    progress: compact,
  };
  return compact.usage === undefined ? updated : { ...updated, usage: compact.usage };
}

export function transitionWorkflowRun(record: WorkflowRunRecord, transition: WorkflowRunTransition): WorkflowRunRecord {
  if (!isAllowedTransition(record.state, transition.state)) {
    throw new Error(`Invalid workflow run transition: ${record.state} -> ${transition.state}.`);
  }
  assertMatchingRun(record.runId, transition.progress.runId);
  const at = transition.at ?? Date.now();
  const progress = compactWorkflowProgress(transition.progress);
  const base: WorkflowRunRecordBase = {
    version: record.version,
    runId: record.runId,
    workflow: record.workflow,
    journalFile: record.journalFile,
    options: record.options,
    createdAt: record.createdAt,
    updatedAt: at,
    progress,
    usage: progress.usage ?? record.usage,
  };

  switch (transition.state) {
    case "queued":
      return { ...base, state: "queued", startedAt: record.startedAt };
    case "running":
      return { ...base, state: "running", startedAt: record.startedAt ?? at };
    case "paused":
      return { ...base, state: "paused", startedAt: record.startedAt ?? record.createdAt, message: boundedText(transition.message) };
    case "completed":
      return {
        ...base,
        state: "completed",
        startedAt: record.startedAt ?? record.createdAt,
        endedAt: at,
        usage: compactWorkflowUsage(transition.usage),
        result: captureWorkflowRunResult(transition.result),
      };
    case "failed":
    case "stopped":
      return {
        ...base,
        state: transition.state,
        startedAt: record.startedAt ?? record.createdAt,
        endedAt: at,
        usage: compactWorkflowUsage(transition.usage),
        message: persistedErrorMessage(transition.error),
      };
  }
}

export function captureWorkflowRunResult(value: unknown): WorkflowRunStoredResult {
  try {
    const state = { nodes: 0, bytes: 0, active: new WeakSet<object>() };
    const captured = captureStoredValue(value, state, 0, false);
    const normalized = captured === undefined ? null : captured;
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_RESULT_BYTES) {
      throw new WorkflowRunValueError(`result exceeded ${MAX_RESULT_BYTES} bytes`);
    }
    return { kind: "value", value: normalized };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: error instanceof WorkflowRunValueError ? error.message : "result inspection failed",
    };
  }
}

function persistedWorkflowIdentity(workflow: LoadedWorkflow): PersistedWorkflowIdentity {
  const sourceFingerprint = workflow.source.kind === "unverifiable" ? undefined : workflow.source.fingerprint;
  return {
    name: boundedText(workflow.meta.name),
    sourceKind: workflow.source.kind,
    sourceFingerprint,
  };
}

function persistedWorkflowRunOptions(options: ResolvedWorkflowRunOptions): PersistedWorkflowRunOptions {
  return {
    inspect: options.inspect ?? false,
    perf: options.perf,
    concurrency: options.concurrency,
    parallelSubmissionLimit: options.parallelSubmissionLimit,
    maxAgents: options.maxAgents,
    agentTimeoutMs: options.agentTimeoutMs,
    agentRetries: options.agentRetries,
    budget: options.budget,
    resultViewer: options.resultViewer,
    resumeFromRunId: options.resumeFromRunId,
  };
}

function compactWorkflowProgress(snapshot: WorkflowProgressSnapshot): WorkflowProgressSnapshot {
  let remainingAgents = MAX_PERSISTED_AGENTS;
  return {
    runId: snapshot.runId,
    title: boundedText(snapshot.title),
    startedAt: snapshot.startedAt,
    doneAt: snapshot.doneAt,
    currentPhase: boundedText(snapshot.currentPhase),
    phases: snapshot.phases.slice(-MAX_PERSISTED_PHASES).map((phase) => {
      const agents = phase.agents.slice(0, remainingAgents).map((agent) => ({
        id: agent.id,
        label: boundedText(agent.label),
        status: agent.status,
        startedAt: agent.startedAt,
        doneAt: agent.doneAt,
        toolUses: agent.toolUses,
        lastTool: agent.lastTool === undefined ? undefined : boundedText(agent.lastTool),
      }));
      remainingAgents -= agents.length;
      return { title: boundedText(phase.title), agents };
    }),
    counters: snapshot.counters
      .slice(-MAX_PERSISTED_COUNTERS)
      .map((counter) => ({ ...counter, key: boundedText(counter.key), label: boundedText(counter.label) })),
    summary: snapshot.summary
      .slice(-MAX_PERSISTED_SUMMARY_ENTRIES)
      .map(([key, value]) => [boundedText(key), typeof value === "string" ? boundedText(value) : value]),
    lanes: snapshot.lanes.slice(0, MAX_PERSISTED_LANES).map(([lane, items]) => [
      boundedText(lane),
      items.slice(-MAX_PERSISTED_LANE_ITEMS).map((item) => ({
        lane: boundedText(item.lane),
        title: boundedText(item.title),
        subtitle: item.subtitle === undefined ? undefined : boundedText(item.subtitle),
        status: item.status,
        createdAt: item.createdAt,
      })),
    ]),
    laneOverflow: snapshot.laneOverflow.slice(0, MAX_PERSISTED_LANES).map(([lane, count]) => [boundedText(lane), count]),
    logs: [],
    usage: snapshot.usage === undefined ? undefined : compactWorkflowUsage(snapshot.usage),
  };
}

function compactWorkflowUsage(snapshot: WorkflowUsageSnapshot): WorkflowUsageSnapshot {
  return {
    agents: snapshot.agents.slice(-MAX_PERSISTED_USAGE_AGENTS).map((agent) => ({
      label: boundedText(agent.label),
      phase: agent.phase === undefined ? undefined : boundedText(agent.phase),
      provider: agent.provider === undefined ? undefined : boundedText(agent.provider),
      model: agent.model === undefined ? undefined : boundedText(agent.model),
      assistantMessages: agent.assistantMessages,
      usage: {
        ...agent.usage,
        coverage: { ...agent.usage.coverage },
        cost: { ...agent.usage.cost },
      },
    })),
    totals: {
      ...snapshot.totals,
      coverage: { ...snapshot.totals.coverage },
      cost: { ...snapshot.totals.cost },
    },
    assistantMessages: snapshot.assistantMessages,
  };
}

function isAllowedTransition(from: WorkflowRunState, to: WorkflowRunState): boolean {
  switch (from) {
    case "queued":
      return to === "running" || to === "failed" || to === "stopped";
    case "running":
      return to === "completed" || to === "failed" || to === "stopped" || to === "paused";
    case "paused":
      return to === "queued" || to === "running" || to === "failed" || to === "stopped";
    case "completed":
    case "failed":
    case "stopped":
      return false;
  }
}

function assertMatchingRun(expected: string, actual: string): void {
  if (expected !== actual) throw new Error(`Workflow progress run id ${actual} does not match ${expected}.`);
}

interface CaptureState {
  nodes: number;
  bytes: number;
  active: WeakSet<object>;
}

function captureStoredValue(
  value: unknown,
  state: CaptureState,
  depth: number,
  arrayItem: boolean,
): WorkflowRunStoredValue | undefined {
  state.nodes += 1;
  if (state.nodes > MAX_RESULT_NODES) throw new WorkflowRunValueError(`result exceeded ${MAX_RESULT_NODES} values`);
  if (depth > MAX_RESULT_DEPTH) throw new WorkflowRunValueError(`result exceeded ${MAX_RESULT_DEPTH} levels`);

  if (value === null) return null;
  switch (typeof value) {
    case "undefined":
      return arrayItem ? null : undefined;
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new WorkflowRunValueError("result contains a non-finite number");
      return value;
    case "string":
      countResultBytes(state, value);
      return value;
    case "bigint":
    case "function":
    case "symbol":
      throw new WorkflowRunValueError(`result contains unsupported ${typeof value} data`);
    case "object":
      break;
  }

  if (state.active.has(value)) throw new WorkflowRunValueError("result contains a cycle");
  state.active.add(value);
  try {
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) throw new WorkflowRunValueError("result contains an array with a custom prototype");
      if (value.length > MAX_RESULT_NODES - state.nodes) {
        throw new WorkflowRunValueError(`result exceeded ${MAX_RESULT_NODES} values`);
      }
      const output: WorkflowRunStoredValue[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) {
          output.push(null);
          continue;
        }
        if (!("value" in descriptor)) {
          output.push(REDACTED);
          continue;
        }
        output.push(captureStoredValue(descriptor.value, state, depth + 1, true) ?? null);
      }
      return output;
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new WorkflowRunValueError("result contains an object with a custom prototype");
    }
    const output: Record<string, WorkflowRunStoredValue> = {};
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      countResultBytes(state, key);
      if (isSensitivePersistenceKey(key) || !("value" in descriptor)) {
        output[key] = REDACTED;
        continue;
      }
      const captured = captureStoredValue(descriptor.value, state, depth + 1, false);
      if (captured !== undefined) output[key] = captured;
    }
    return output;
  } finally {
    state.active.delete(value);
  }
}

function countResultBytes(state: CaptureState, value: string): void {
  state.bytes += Buffer.byteLength(value);
  if (state.bytes > MAX_RESULT_BYTES) throw new WorkflowRunValueError(`result exceeded ${MAX_RESULT_BYTES} bytes`);
}

function isSensitivePersistenceKey(key: string): boolean {
  return /^(?:api[-_]?key|authorization|cookie|credentials?|env|environment|messages?|password|private[-_]?key|prompts?|secret|tool[-_]?outputs?|tool[-_]?results?|transcripts?)$/i.test(key);
}

function persistedErrorMessage(error: unknown): string {
  return boundedText(
    unknownErrorMessage(error)
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\b(?:api[-_ ]?key|authorization|cookie|credentials?|password|private[-_ ]?key|secret|token)\s*[:=]\s*[^\s,;]+/gi, "credential=[redacted]")
      .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/g, REDACTED),
  );
}

function boundedText(value: string): string {
  return value.length <= MAX_PERSISTED_TEXT ? value : `${value.slice(0, MAX_PERSISTED_TEXT - 1)}…`;
}

export function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
  if (!isRecord(value) || value.version !== WORKFLOW_RUN_RECORD_VERSION) return false;
  if (!isValidRunId(value.runId) || !isWorkflowRunState(value.state)) return false;
  if (!isPersistedWorkflowIdentity(value.workflow) || !isPersistedWorkflowRunOptions(value.options)) return false;
  if (value.journalFile !== `${value.runId}.jsonl`) return false;
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt)) return false;
  if (value.startedAt !== undefined && !isFiniteNumber(value.startedAt)) return false;
  if (value.endedAt !== undefined && !isFiniteNumber(value.endedAt)) return false;
  if (!isWorkflowProgressSnapshot(value.progress) || value.progress.runId !== value.runId) return false;
  if (value.usage !== undefined && !isWorkflowUsageSnapshot(value.usage)) return false;
  if (value.result !== undefined && !isWorkflowRunStoredResult(value.result)) return false;
  if (value.message !== undefined && typeof value.message !== "string") return false;
  switch (value.state) {
    case "queued":
      return value.endedAt === undefined && value.result === undefined && value.message === undefined;
    case "running":
      return value.startedAt !== undefined && value.endedAt === undefined && value.result === undefined && value.message === undefined;
    case "paused":
      return value.startedAt !== undefined && value.endedAt === undefined && value.result === undefined && value.message !== undefined;
    case "completed":
      return value.startedAt !== undefined && value.endedAt !== undefined && value.usage !== undefined && value.result !== undefined && value.message === undefined;
    case "failed":
    case "stopped":
      return value.startedAt !== undefined && value.endedAt !== undefined && value.usage !== undefined && value.result === undefined && value.message !== undefined;
  }
}

function isPersistedWorkflowIdentity(value: unknown): value is PersistedWorkflowIdentity {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.sourceKind !== "file" && value.sourceKind !== "fingerprint" && value.sourceKind !== "unverifiable") return false;
  return value.sourceKind === "unverifiable"
    ? value.sourceFingerprint === undefined
    : typeof value.sourceFingerprint === "string";
}

function isPersistedWorkflowRunOptions(value: unknown): value is PersistedWorkflowRunOptions {
  if (!isRecord(value)) return false;
  if (typeof value.inspect !== "boolean" || typeof value.perf !== "boolean") return false;
  if (!isFiniteNumber(value.concurrency) || !isFiniteNumber(value.maxAgents)) return false;
  if (!isFiniteNumber(value.agentTimeoutMs) || !isFiniteNumber(value.agentRetries)) return false;
  if (value.parallelSubmissionLimit !== null && !isFiniteNumber(value.parallelSubmissionLimit)) return false;
  if (value.budget !== null && !isFiniteNumber(value.budget)) return false;
  if (value.resultViewer !== undefined && value.resultViewer !== "open" && value.resultViewer !== "skip") return false;
  return value.resumeFromRunId === undefined || typeof value.resumeFromRunId === "string";
}

function isWorkflowProgressSnapshot(value: unknown): value is WorkflowProgressSnapshot {
  if (!isRecord(value) || typeof value.runId !== "string" || typeof value.title !== "string") return false;
  if (!isFiniteNumber(value.startedAt) || typeof value.currentPhase !== "string") return false;
  if (value.doneAt !== undefined && !isFiniteNumber(value.doneAt)) return false;
  if (!Array.isArray(value.phases) || !value.phases.every(isPhaseSnapshot)) return false;
  if (!Array.isArray(value.counters) || !value.counters.every(isCounterSnapshot)) return false;
  if (!Array.isArray(value.summary) || !value.summary.every(isSummaryEntry)) return false;
  if (!Array.isArray(value.lanes) || !value.lanes.every(isLaneSnapshot)) return false;
  if (!Array.isArray(value.laneOverflow) || !value.laneOverflow.every(isLaneOverflowEntry)) return false;
  if (!Array.isArray(value.logs) || !value.logs.every((log) => typeof log === "string")) return false;
  return value.usage === undefined || isWorkflowUsageSnapshot(value.usage);
}

function isPhaseSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.title === "string" && Array.isArray(value.agents) && value.agents.every(isAgentSnapshot);
}

function isAgentSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isFiniteNumber(value.id) || typeof value.label !== "string") return false;
  if (value.status !== "queued" && value.status !== "running" && value.status !== "done" && value.status !== "failed") return false;
  if (!isFiniteNumber(value.toolUses)) return false;
  if (value.startedAt !== undefined && !isFiniteNumber(value.startedAt)) return false;
  if (value.doneAt !== undefined && !isFiniteNumber(value.doneAt)) return false;
  if (value.lastTool !== undefined && typeof value.lastTool !== "string") return false;
  return value.error === undefined || typeof value.error === "string";
}

function isCounterSnapshot(value: unknown): boolean {
  return isRecord(value) && typeof value.key === "string" && typeof value.label === "string" && isFiniteNumber(value.value);
}

function isSummaryEntry(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && (typeof value[1] === "string" || isFiniteNumber(value[1]));
}

function isLaneSnapshot(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && Array.isArray(value[1]) && value[1].every(isLaneItemSnapshot);
}

function isLaneItemSnapshot(value: unknown): boolean {
  if (!isRecord(value) || typeof value.lane !== "string" || typeof value.title !== "string") return false;
  if (value.subtitle !== undefined && typeof value.subtitle !== "string") return false;
  if (value.status !== "pending" && value.status !== "running" && value.status !== "success" && value.status !== "warning" && value.status !== "error") return false;
  if (!isFiniteNumber(value.createdAt)) return false;
  return value.details === undefined || typeof value.details === "string";
}

function isLaneOverflowEntry(value: unknown): boolean {
  return Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && isFiniteNumber(value[1]);
}

function isWorkflowRunStoredResult(value: unknown): value is WorkflowRunStoredResult {
  if (!isRecord(value)) return false;
  if (value.kind === "unavailable") return typeof value.reason === "string";
  return value.kind === "value" && isWorkflowRunStoredValue(value.value);
}

function isWorkflowRunStoredValue(value: unknown): value is WorkflowRunStoredValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isWorkflowRunStoredValue);
  return isRecord(value) && Object.values(value).every(isWorkflowRunStoredValue);
}

function isWorkflowRunState(value: unknown): value is WorkflowRunState {
  return value === "queued" || value === "running" || value === "completed" || value === "failed" || value === "stopped" || value === "paused";
}

function isValidRunId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return validateWorkflowRunId(value) === value;
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class WorkflowRunValueError extends Error {}
