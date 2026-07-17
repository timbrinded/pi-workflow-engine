import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedWorkflowRunOptions } from "./options.ts";
import type { PerfAggregate, PerfSink, PerfSnapshot } from "./perf.ts";
import type { WorkflowProgressSnapshot } from "./progress.ts";
import type {
  LoadedWorkflow,
  WorkflowProgressSource,
  WorkflowRef,
  WorkflowRunMetadata,
} from "./types.ts";
import type { WorkflowUsageSnapshot } from "./usage.ts";

export interface WorkflowPerfDetails {
  readonly enabled: boolean;
  readonly startedAt: number;
  readonly aggregates: readonly PerfAggregate[];
}

export interface WorkflowResultEnvelope {
  readonly name: string;
  readonly result: unknown;
  readonly completedAt: number;
  readonly usage?: WorkflowUsageSnapshot;
  readonly perf?: WorkflowPerfDetails;
  readonly runId?: string;
  readonly resumedFromRunId?: string;
}

export type ResolvedWorkflowRunner = (
  ctx: ExtensionContext,
  mod: LoadedWorkflow,
  args: string,
  options: ResolvedWorkflowRunOptions,
) => Promise<unknown>;

export interface WorkflowExecutionInput {
  readonly ctx: ExtensionContext;
  readonly name: string;
  readonly mod: LoadedWorkflow;
  readonly args: string;
  readonly options: ResolvedWorkflowRunOptions;
  readonly perfRecorder?: PerfSink;
  readonly runResolvedWorkflow: ResolvedWorkflowRunner;
  readonly resolveWorkflow: (ref: WorkflowRef) => Promise<LoadedWorkflow>;
  readonly onProgressSource?: (source: WorkflowProgressSource | undefined) => void | Promise<void>;
  readonly onProgressSnapshot?: (snapshot: WorkflowProgressSnapshot) => void | Promise<void>;
}

export interface WorkflowExecution {
  readonly metadata?: WorkflowRunMetadata;
  readonly envelope: WorkflowResultEnvelope;
}

/** Shared command/tool execution path. The engine remains lazy-loaded by the caller. */
export async function executeWorkflowInvocation(input: WorkflowExecutionInput): Promise<WorkflowExecution> {
  let perfSnapshot: PerfSnapshot | undefined;
  let usageSnapshot: WorkflowUsageSnapshot | undefined;
  let runMetadata: WorkflowRunMetadata | undefined;
  const { options } = input;
  const runOptions: ResolvedWorkflowRunOptions = {
    ...options,
    perfRecorder: input.perfRecorder,
    resolveWorkflow: input.resolveWorkflow,
    onProgressSource(source) {
      return notifyLifecycleObservers(
        () => input.onProgressSource?.(source),
        () => options.onProgressSource?.(source),
      );
    },
    onPerfSnapshot(snapshot) {
      perfSnapshot = snapshot;
      return notifyLifecycleObservers(() => options.onPerfSnapshot?.(snapshot));
    },
    onUsageSnapshot(snapshot) {
      usageSnapshot = snapshot;
      return notifyLifecycleObservers(() => options.onUsageSnapshot?.(snapshot));
    },
    onRunMetadata(metadata) {
      runMetadata = metadata;
      return notifyLifecycleObservers(() => options.onRunMetadata?.(metadata));
    },
    onProgressSnapshot(snapshot) {
      return notifyLifecycleObservers(
        () => input.onProgressSnapshot?.(snapshot),
        () => options.onProgressSnapshot?.(snapshot),
      );
    },
  };
  const result = await input.runResolvedWorkflow(input.ctx, input.mod, input.args, runOptions);
  const perf = compactPerfSnapshot(perfSnapshot);
  return {
    metadata: runMetadata,
    envelope: {
      name: input.name,
      result,
      completedAt: Date.now(),
      usage: usageSnapshot,
      perf,
      runId: runMetadata?.runId,
      resumedFromRunId: runMetadata?.resumedFromRunId,
    },
  };
}

function compactPerfSnapshot(snapshot: PerfSnapshot | undefined): WorkflowPerfDetails | undefined {
  if (!snapshot?.enabled) return undefined;
  return { enabled: true, startedAt: snapshot.startedAt, aggregates: snapshot.aggregates };
}

async function notifyLifecycleObservers(...observers: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const observer of observers) {
    try {
      await observer();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Workflow lifecycle observers failed");
}
