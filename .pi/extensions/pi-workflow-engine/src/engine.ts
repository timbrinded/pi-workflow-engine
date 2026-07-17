import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { bindParallel, bindPipeline, Semaphore } from "./concurrency.ts";
import { linkAbortSignal, throwIfAborted } from "./cancellation.ts";
import { createBudget } from "./budget.ts";
import { runAgent, type AgentExecutionOptions, type RunContext } from "./agent-runner.ts";
import { ProgressTracker } from "./progress.ts";
import { createPerfRecorder, type PerfSink, type PerfSnapshot } from "./perf.ts";
import { createWorkflowUsageRecorder, type WorkflowUsageSink } from "./usage.ts";
import { resolveWorkflowRunOptions, type ResolvedWorkflowRunOptions } from "./options.ts";
import type { AgentOptions, IsolatedAgentResult, LoadedWorkflow, WorkflowApi, WorkflowProgressEvent, WorkflowRef, WorkflowRunOptions } from "./types.ts";
import { WorkflowInspector } from "./ui/workflow-inspector.ts";
import { createWorkflowJournal, createWorkflowRunId, pruneWorkflowJournals, workflowJournalPath } from "./journal.ts";
import { WorktreeRegistry } from "./worktree.ts";
import { runFinalizers } from "./finalizers.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import {
  captureWorkflowResumeContext,
  type AgentResumeBaseContext,
} from "./resume-context.ts";

/** The workflow-facing slice of the progress tracker (satisfied by `ProgressTracker`). */
export interface WorkflowProgress {
  phase(title: string): void;
  log(message: string): void;
  event(event: WorkflowProgressEvent): void;
}

/** Engine state shared by the workflow and its individual agent calls. */
export type WorkflowRunContext = RunContext;

/** Per-context knobs threaded through `runWorkflowWithContext` (and re-derived for each sub-workflow). */
export interface WorkflowContextOptions {
  /** Controller whose `.signal` equals `rc.signal`; aborts in-flight `parallel` siblings on failure. */
  abortController: AbortController;
  /** Eager-submission cap for `parallel`. */
  submissionLimit: number;
  /** Resolve a sub-workflow reference for `api.workflow()`. Omit to disable composition. */
  resolveWorkflow?: (ref: WorkflowRef) => Promise<LoadedWorkflow>;
  /** Nesting depth. Sub-workflows run at depth >= 1, where `api.workflow()` rejects. */
  depth?: number;
  /** Prefix applied to phase titles so sub-workflow phases nest as "<name> ▸ <title>". */
  progressPrefix?: string;
  /** Namespace applied to child structured progress keys/lanes/logs. */
  progressNamespace?: string;
}

type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

export interface WorkflowEngineDependencies {
  readonly worktrees?: WorktreeRegistry;
}

/**
 * Run a workflow module: build the per-run primitives (binding agent/parallel/pipeline
 * to a shared semaphore + progress tracker), invoke the workflow, return its result.
 */
export async function runWorkflow(
  ctx: ExtensionContext,
  mod: LoadedWorkflow,
  args: string,
  options: WorkflowRunOptions = {},
  dependencies: WorkflowEngineDependencies = {},
): Promise<unknown> {
  return await runResolvedWorkflow(ctx, mod, args, resolveWorkflowRunOptions(options), dependencies);
}

/** Execute an options-normalized workflow without re-reading environment defaults. */
export async function runResolvedWorkflow(
  ctx: ExtensionContext,
  mod: LoadedWorkflow,
  args: string,
  resolvedOptions: ResolvedWorkflowRunOptions,
  dependencies: WorkflowEngineDependencies = {},
): Promise<unknown> {
  const progress = new ProgressTracker(ctx, mod.meta.name);
  const progressSource = { snapshot: () => progress.snapshot() };
  const perf = resolvedOptions.perfRecorder ?? createPerfRecorder(resolvedOptions.perf);
  const usage = createWorkflowUsageRecorder();
  const budget = createBudget(resolvedOptions.budget, usage);
  const runId = resolvedOptions.runId ?? createWorkflowRunId();
  const journalPath = workflowJournalPath(ctx.cwd, runId);
  const resumePath = resolvedOptions.resumeFromRunId ? workflowJournalPath(ctx.cwd, resolvedOptions.resumeFromRunId) : undefined;
  const worktrees = dependencies.worktrees ?? new WorktreeRegistry(ctx.cwd);
  const runAbortController = new AbortController();
  const unlinkContextAbortSignal = linkAbortSignal(ctx.signal, runAbortController);
  const unlinkOptionAbortSignal = linkAbortSignal(resolvedOptions.signal, runAbortController);
  const workflowOutcome = await captureOutcome(async () => {
    await notifyLifecycleObserver(progress, "progress source callback", () => resolvedOptions.onProgressSource?.(progressSource));
    if (resolvedOptions.inspect && ctx.hasUI) {
      void ctx.ui
        .custom<void>(
          (tui, theme, _keybindings, done) => new WorkflowInspector(() => progress.snapshot(), tui, theme, () => done(undefined)),
          { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
        )
        .catch((error: unknown) => {
          try {
            progress.log(`inspector failed: ${unknownErrorMessage(error)}`);
          } catch {
            // Inspector reporting is detached and must never become another rejection.
          }
        });
    }

    const journal = await createWorkflowJournal({ resumePath, writePath: journalPath });
    await notifyLifecycleObserver(progress, "run metadata callback", () =>
      resolvedOptions.onRunMetadata?.({ runId, resumedFromRunId: resolvedOptions.resumeFromRunId, journalPath }),
    );
    progress.log(resolvedOptions.resumeFromRunId ? `run id: ${runId} (resuming from ${resolvedOptions.resumeFromRunId})` : `run id: ${runId}`);
    const rc: WorkflowRunContext = {
      cwd: ctx.cwd,
      hostModel: ctx.model,
      modelRegistry: ctx.modelRegistry,
      semaphore: new Semaphore(resolvedOptions.concurrency),
      progress,
      signal: runAbortController.signal,
      perf,
      usage,
      budget,
      journal,
      worktrees,
    };

    // perf.total_ms wraps the whole tree: sub-workflows run inside this span via api.workflow().
    return perf.time("workflow.total_ms", () =>
      runWorkflowWithContext(rc, progress, mod, args, {
        abortController: runAbortController,
        submissionLimit: resolvedOptions.parallelSubmissionLimit ?? resolvedOptions.concurrency * 2,
        resolveWorkflow: resolvedOptions.resolveWorkflow,
        depth: 0,
        progressPrefix: "",
      }),
    );
  });

  const finalizationOutcome = await captureOutcome(() =>
    finalizeWorkflowRun({
      cwd: ctx.cwd,
      options: resolvedOptions,
      perf,
      usage,
      progress,
      worktrees,
      unlinkSignals: [unlinkContextAbortSignal, unlinkOptionAbortSignal],
    }),
  );

  if (workflowOutcome.ok) {
    if (finalizationOutcome.ok) return workflowOutcome.value;
    throw finalizationOutcome.error;
  }
  if (finalizationOutcome.ok) throw workflowOutcome.error;
  throw combinedWorkflowError(workflowOutcome.error, finalizationOutcome.error);
}

async function captureOutcome<T>(operation: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return { ok: false, error };
  }
}

interface WorkflowFinalizationInput {
  readonly cwd: string;
  readonly options: ResolvedWorkflowRunOptions;
  readonly perf: PerfSink;
  readonly usage: WorkflowUsageSink;
  readonly progress: ProgressTracker;
  readonly worktrees: WorktreeRegistry;
  readonly unlinkSignals: readonly (() => void)[];
}

async function finalizeWorkflowRun(input: WorkflowFinalizationInput): Promise<void> {
  await runFinalizers(
    [
      {
        name: "usage snapshot callback",
        criticality: "best-effort",
        run: () => input.options.onUsageSnapshot?.(input.usage.snapshot()),
      },
      {
        name: "performance snapshot callback",
        criticality: "best-effort",
        run: async () => {
          if (!input.options.perf) return;
          const snapshot = input.perf.snapshot();
          await input.options.onPerfSnapshot?.(snapshot);
          input.progress.log(formatPerfSummary(snapshot));
        },
      },
      ...input.unlinkSignals.map((run, index) => ({
        name: `abort signal unlink ${index + 1}`,
        criticality: "required" as const,
        run,
      })),
      {
        name: "worktree cleanup",
        criticality: "required",
        run: () => input.worktrees.removeAll(),
      },
      { name: "journal pruning", criticality: "best-effort", run: () => pruneWorkflowJournals(input.cwd) },
      { name: "progress completion", criticality: "best-effort", run: () => input.progress.done() },
      {
        name: "progress snapshot callback",
        criticality: "best-effort",
        run: () => input.options.onProgressSnapshot?.(input.progress.snapshot()),
      },
      {
        name: "progress source clear",
        criticality: "best-effort",
        run: () => input.options.onProgressSource?.(undefined),
      },
    ],
    {
      onBestEffortFailure: (failure) => {
        try {
          input.progress.log(`${failure.name} failed: ${unknownErrorMessage(failure.error)}`);
        } catch {
          // Observer failures must never replace the workflow outcome.
        }
      },
    },
  );
}

function combinedWorkflowError(workflowError: unknown, finalizationError: unknown): AggregateError {
  return new AggregateError(
    [workflowError, finalizationError],
    `Workflow failed: ${unknownErrorMessage(workflowError)}; finalization also failed: ${unknownErrorMessage(finalizationError)}`,
  );
}

function createWorkflowAgent(
  rc: WorkflowRunContext,
  scope: WorkflowScope,
  mod: LoadedWorkflow,
  resumeContext: AgentResumeBaseContext,
): WorkflowApi["agent"] {
  function agent<S extends TSchema>(
    prompt: string,
    opts: AgentOptions<S> & { schema: S; isolation: "worktree" },
  ): Promise<IsolatedAgentResult<Static<S> | null>>;
  function agent(prompt: string, opts: AgentOptions & { isolation: "worktree" }): Promise<IsolatedAgentResult<string>>;
  function agent<S extends TSchema>(prompt: string, opts: AgentOptions<S> & { schema: S }): Promise<Static<S> | null>;
  function agent(prompt: string, opts?: AgentOptions): Promise<string>;
  function agent(prompt: string, agentOpts?: AgentOptions): Promise<unknown> {
    const scopedOptions = scope.agentOptions(agentOpts);
    const executionOptions: AgentExecutionOptions =
      scopedOptions.isolation === "worktree" && mod.isolatedWorktreeBaseline !== undefined
        ? { ...scopedOptions, worktreeBaseline: mod.isolatedWorktreeBaseline }
        : scopedOptions;
    return runAgent(rc, prompt, executionOptions, resumeContext);
  }
  return agent;
}

/**
 * Build the `WorkflowApi` from an existing run context and invoke the module. Reused for both
 * the top-level run and every `api.workflow()` sub-step, so children share the parent's semaphore,
 * abort signal, and perf sink. No setup/teardown of its own — that belongs to `runWorkflow`.
 */
export async function runWorkflowWithContext(
  rc: WorkflowRunContext,
  progress: WorkflowProgress,
  mod: LoadedWorkflow,
  args: string,
  opts: WorkflowContextOptions,
): Promise<unknown> {
  const depth = opts.depth ?? 0;
  const scope = createWorkflowScope(progress, opts.progressPrefix ?? "", opts.progressNamespace);
  const resumeContext: AgentResumeBaseContext = {
    workflow: await captureWorkflowResumeContext(mod, rc.signal),
  };

  const agent = createWorkflowAgent(rc, scope, mod, resumeContext);

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
    parallel: bindParallel({
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

  throwIfAborted(rc.signal);
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

async function notifyLifecycleObserver(
  progress: ProgressTracker,
  name: string,
  notify: () => void | Promise<void>,
): Promise<void> {
  try {
    await notify();
  } catch (error) {
    try {
      progress.log(`${name} failed: ${unknownErrorMessage(error)}`);
    } catch {
      // Lifecycle observers are advisory and must not replace the workflow outcome.
    }
  }
}
