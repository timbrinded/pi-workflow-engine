import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bindPipeline, parallel, Semaphore } from "./concurrency.ts";
import { linkAbortSignal } from "./cancellation.ts";
import { createBudget } from "./budget.ts";
import { runAgent, type RunContext } from "./agent-runner.ts";
import { ProgressTracker } from "./progress.ts";
import { createPerfRecorder, type PerfSnapshot } from "./perf.ts";
import { createWorkflowUsageRecorder } from "./usage.ts";
import { defaultConcurrency, resolveWorkflowRunOptions } from "./options.ts";
import type { AgentOptions, WorkflowApi, WorkflowModule, WorkflowProgressEvent, WorkflowRef, WorkflowRunOptions } from "./types.ts";
import { WorkflowInspector } from "./ui/workflow-inspector.ts";
import {
  createAgentIndexCounter,
  createWorkflowJournal,
  createWorkflowRunId,
  pruneWorkflowJournals,
  workflowJournalPath,
} from "./journal.ts";

/** Default global cap on concurrent agents per run. */
const DEFAULT_CONCURRENCY = defaultConcurrency();

/** The workflow-facing slice of the progress tracker (satisfied by `ProgressTracker`). */
export interface WorkflowProgress {
  phase(title: string): void;
  log(message: string): void;
  event(event: WorkflowProgressEvent): void;
}

/** Per-context knobs threaded through `runWorkflowWithContext` (and re-derived for each sub-workflow). */
export interface WorkflowContextOptions {
  /** Controller whose `.signal` equals `rc.signal`; aborts in-flight `parallel` siblings on failure. */
  abortController: AbortController;
  /** Eager-submission cap for `parallel`. */
  submissionLimit: number;
  /** Resolve a sub-workflow reference for `api.workflow()`. Omit to disable composition. */
  resolveWorkflow?: (ref: WorkflowRef) => Promise<WorkflowModule>;
  /** Nesting depth. Sub-workflows run at depth >= 1, where `api.workflow()` rejects. */
  depth?: number;
  /** Prefix applied to phase titles so sub-workflow phases nest as "<name> ▸ <title>". */
  progressPrefix?: string;
  /** Namespace applied to child structured progress keys/lanes/logs. */
  progressNamespace?: string;
}

/**
 * Run a workflow module: build the per-run primitives (binding agent/parallel/pipeline
 * to a shared semaphore + progress tracker), invoke the workflow, return its result.
 */
export async function runWorkflow(
  ctx: ExtensionContext,
  mod: WorkflowModule,
  args: string,
  options: WorkflowRunOptions = {},
): Promise<unknown> {
  const resolvedOptions = resolveWorkflowRunOptions(options);
  const progress = new ProgressTracker(ctx, mod.meta.name);
  const progressSource = { snapshot: () => progress.snapshot() };
  resolvedOptions.onProgressSource?.(progressSource);
  if (resolvedOptions.inspect && ctx.hasUI) {
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => new WorkflowInspector(() => progress.snapshot(), tui, theme, () => done(undefined)),
        { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
      )
      .catch((error: unknown) => progress.log(`inspector failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  const perf = resolvedOptions.perfRecorder ?? createPerfRecorder(resolvedOptions.perf);
  const usage = createWorkflowUsageRecorder();
  const budget = createBudget(resolvedOptions.budget ?? null, usage);
  const runId = resolvedOptions.runId ?? createWorkflowRunId();
  const journalPath = workflowJournalPath(ctx.cwd, runId);
  const resumePath = resolvedOptions.resumeFromRunId ? workflowJournalPath(ctx.cwd, resolvedOptions.resumeFromRunId) : undefined;
  const journal = await createWorkflowJournal({ resumePath, writePath: journalPath });
  resolvedOptions.onRunMetadata?.({ runId, resumedFromRunId: resolvedOptions.resumeFromRunId, journalPath });
  progress.log(resolvedOptions.resumeFromRunId ? `run id: ${runId} (resuming from ${resolvedOptions.resumeFromRunId})` : `run id: ${runId}`);
  const runAbortController = new AbortController();
  const unlinkContextAbortSignal = linkAbortSignal(ctx.signal, runAbortController);
  const unlinkOptionAbortSignal = linkAbortSignal(resolvedOptions.signal, runAbortController);
  const rc: RunContext = {
    cwd: ctx.cwd,
    hostModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
    semaphore: new Semaphore(resolvedOptions.concurrency ?? DEFAULT_CONCURRENCY),
    progress,
    signal: runAbortController.signal,
    perf,
    usage,
    budget,
    journal,
    nextAgentIndex: createAgentIndexCounter(),
  };

  try {
    // perf.total_ms wraps the whole tree: sub-workflows run inside this span via api.workflow().
    return await perf.time("workflow.total_ms", () =>
      runWorkflowWithContext(rc, progress, mod, args, {
        abortController: runAbortController,
        submissionLimit: resolvedOptions.parallelSubmissionLimit ?? resolvedOptions.concurrency * 2,
        resolveWorkflow: resolvedOptions.resolveWorkflow,
        depth: 0,
        progressPrefix: "",
      }),
    );
  } finally {
    try {
      resolvedOptions.onUsageSnapshot?.(usage.snapshot());
      const snapshot = perf.snapshot();
      if (resolvedOptions.perf) {
        resolvedOptions.onPerfSnapshot?.(snapshot);
        progress.log(formatPerfSummary(snapshot));
      }
      progress.done();
      resolvedOptions.onProgressSnapshot?.(progress.snapshot());
    } finally {
      resolvedOptions.onProgressSource?.(undefined);
      unlinkContextAbortSignal();
      unlinkOptionAbortSignal();
      await pruneWorkflowJournals(ctx.cwd);
    }
  }
}

/**
 * Build the `WorkflowApi` from an existing run context and invoke the module. Reused for both
 * the top-level run and every `api.workflow()` sub-step, so children share the parent's semaphore,
 * abort signal, and perf sink. No setup/teardown of its own — that belongs to `runWorkflow`.
 */
export async function runWorkflowWithContext(
  rc: RunContext,
  progress: WorkflowProgress,
  mod: WorkflowModule,
  args: string,
  opts: WorkflowContextOptions,
): Promise<unknown> {
  const depth = opts.depth ?? 0;
  const scope = createWorkflowScope(progress, opts.progressPrefix ?? "", opts.progressNamespace);

  const agent = ((prompt: string, agentOpts?: AgentOptions) => runAgent(rc, prompt, scope.agentOptions(agentOpts))) as WorkflowApi["agent"];

  const workflow: WorkflowApi["workflow"] =
    depth >= 1
      ? async () => {
          throw new Error("workflow() can only nest one level deep");
        }
      : async (ref, childArgs) => {
          if (!opts.resolveWorkflow) throw new Error("sub-workflows are not enabled in this context");
          const childMod = await opts.resolveWorkflow(ref);
          // A child controller isolates the child's failures from the parent (so the parent can
          // try/catch a failed sub-workflow), while still cancelling the child when the run aborts.
          const childController = new AbortController();
          const unlink = linkAbortSignal(rc.signal, childController);
          try {
            return await runWorkflowWithContext({ ...rc, signal: childController.signal }, progress, childMod, childArgs ?? "", {
              abortController: childController,
              submissionLimit: opts.submissionLimit,
              resolveWorkflow: opts.resolveWorkflow,
              depth: depth + 1,
              progressPrefix: `${childMod.meta.name} ▸ `,
              progressNamespace: childMod.meta.name,
            });
          } finally {
            unlink();
            scope.restorePhase();
          }
        };

  const api: WorkflowApi = {
    agent,
    workflow,
    parallel: (thunks) =>
      parallel(thunks, {
        signal: rc.signal,
        abortController: opts.abortController,
        limit: opts.submissionLimit,
      }),
    pipeline: bindPipeline({ signal: rc.signal, abortController: opts.abortController }),
    phase: scope.phase,
    log: scope.log,
    progress: scope.event,
    args,
    cwd: rc.cwd,
    budget: rc.budget,
    signal: rc.signal,
  };

  return await mod.default(api);
}

interface WorkflowScope {
  agentOptions(opts: AgentOptions | undefined): AgentOptions;
  phase(title: string): void;
  log(message: string): void;
  event(event: WorkflowProgressEvent): void;
  restorePhase(): void;
}

function createWorkflowScope(progress: WorkflowProgress, prefix: string, namespace: string | undefined): WorkflowScope {
  let currentPhase = `${prefix}Workflow`;
  const display = (title: string) => `${prefix}${title}`;
  return {
    agentOptions(opts) {
      const phase = opts?.phase ? display(opts.phase) : currentPhase;
      return opts ? { ...opts, phase } : { phase };
    },
    phase(title) {
      currentPhase = display(title);
      progress.phase(currentPhase);
    },
    log(message) {
      progress.log(namespace ? `${namespace}: ${message}` : message);
    },
    event(event) {
      progress.event(namespace ? namespaceProgressEvent(namespace, event) : event);
    },
    restorePhase() {
      progress.phase(currentPhase);
    },
  };
}

function namespaceProgressEvent(namespace: string, event: WorkflowProgressEvent): WorkflowProgressEvent {
  switch (event.type) {
    case "counter":
      return { ...event, key: `${namespace}.${event.key}` };
    case "counter_delta":
      return { ...event, key: `${namespace}.${event.key}` };
    case "lane_item":
      return { ...event, lane: `${namespace} ▸ ${event.lane}` };
    case "summary":
      return { ...event, key: `${namespace}.${event.key}` };
  }
}

function formatPerfSummary(snapshot: PerfSnapshot): string {
  const parts = snapshot.aggregates
    .filter((aggregate) => aggregate.count > 0)
    .slice(0, 5)
    .map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `perf: ${parts.join(", ")}` : "perf: no samples";
}
