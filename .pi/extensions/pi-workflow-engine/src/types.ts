import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { WorkflowBudget } from "./budget.ts";
import type { Pipeline, WorkflowParallel } from "./concurrency.ts";
import type { PerfSink, PerfSnapshot } from "./perf.ts";
import type { WorkflowLaneItemStatus, WorkflowProgressSnapshot } from "./progress-types.ts";
import type { WorkflowUsageSnapshot } from "./usage.ts";
import type { WorktreeBaseline } from "./worktree.ts";

export type { WorkflowLaneItemStatus } from "./progress-types.ts";

/** A reference to a registered workflow by name. */
export type WorkflowRef = string;

/** Metadata every workflow module must export. */
export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: Array<{ title: string }>;
}

export interface WorkflowRunStats {
  files: number;
  candidates: number;
  verified: number;
  kept: number;
  [key: string]: string | number;
}

export interface WorkflowRunMetadata {
  readonly runId: string;
  readonly resumedFromRunId?: string;
  readonly journalPath: string;
}

export interface WorkflowRunOptions {
  inspect?: boolean;
  perf?: boolean;
  concurrency?: number;
  parallelSubmissionLimit?: number;
  /** Maximum number of agent calls that may reach a live model session during this run. */
  maxAgents?: number;
  /** Maximum live duration of one agent call in milliseconds. */
  agentTimeoutMs?: number;
  /** Retry count for transient provider/session failures. Defaults to zero. */
  agentRetries?: number;
  /** Output-token ceiling across recorded subagent attempts. Omit for no limit (budget.total === null). */
  budget?: number;
  /** Internal/test override for the generated run id. Omit to generate a new id. */
  runId?: string;
  /** Replay completed agent results from this prior run id when call and execution context still match. */
  resumeFromRunId?: string;
  resultViewer?: "open" | "skip";
  /** Additional abort signal to compose with the host context signal. */
  signal?: AbortSignal;
  /** Internal recorder override for command/tool invocation timing. */
  perfRecorder?: PerfSink;
  /** Resolve a sub-workflow reference to a module, enabling `api.workflow()`. When omitted, `api.workflow()` throws. */
  resolveWorkflow?: (ref: WorkflowRef) => Promise<LoadedWorkflow>;
  /** Called with the final performance snapshot when perf is enabled. */
  onPerfSnapshot?: (snapshot: PerfSnapshot) => void | Promise<void>;
  /** Called with the final workflow subagent usage snapshot. */
  onUsageSnapshot?: (snapshot: WorkflowUsageSnapshot) => void | Promise<void>;
  /** Called once run identity and journal paths are known. */
  onRunMetadata?: (metadata: WorkflowRunMetadata) => void | Promise<void>;
  /** Called with the live progress source while a workflow is running, then undefined when it ends. */
  onProgressSource?: (source: WorkflowProgressSource | undefined) => void | Promise<void>;
  /** Called with the final completed progress snapshot after live workflow UI teardown. */
  onProgressSnapshot?: (snapshot: WorkflowProgressSnapshot) => void | Promise<void>;
}

export interface WorkflowProgressSource {
  snapshot(): WorkflowProgressSnapshot;
}

/** Options for a single `agent()` call. */
export type AgentToolHint = "search";
export type AgentResumePolicy = "read-only" | "off";

export interface IsolatedAgentResult<T> {
  readonly result: T;
  readonly patch: string;
  readonly changed: boolean;
}

export type WorkflowProgressEvent =
  | { type: "counter"; key: string; label: string; value: number }
  | { type: "counter_delta"; key: string; label: string; delta: number }
  | {
      type: "lane_item";
      lane: string;
      title: string;
      subtitle?: string;
      status: WorkflowLaneItemStatus;
      details?: string;
    }
  | { type: "summary"; key: string; value: string | number };

export interface AgentOptions<S extends TSchema = TSchema> {
  /** Label shown in the progress tree (e.g. "find:logic-bugs"). */
  label?: string;
  /** Phase to group this agent under in the progress tree. */
  phase?: string;
  /**
   * Optional model id. Omit to inherit the host model. Explicit refs are strict:
   * bare ids resolve as Anthropic shorthand; use "provider/id" for other providers.
   */
  model?: string;
  /** Reasoning effort for this agent. */
  thinkingLevel?: ThinkingLevel;
  /**
   * Stable identity hint for resume replay. Use this for repeated logical calls
   * with identical prompts/options, e.g. `${stage}:${item.id}`.
   */
  cacheKey?: string;
  /**
   * Resume policy for this call. Shared-workspace agents run live unless they
   * explicitly declare themselves read-only. Those calls bind replay to the full
   * Git-visible workspace; isolated agents bind to their disposable baseline.
   * Use "off" to disable both journal reads and writes.
   */
  resume?: AgentResumePolicy;
  /**
   * Additional ignored/generated inputs under the workflow cwd that this
   * read-only agent may observe. Git-visible files across the repository are
   * captured automatically; list cwd-relative ignored paths here or use
   * `resume: "off"` when their bounded contents cannot be captured.
   */
  resumeInputs?: readonly string[];
  /** Run this agent in a disposable git worktree and return its patch with the result. */
  isolation?: "worktree";
  /** Allowlist of concrete tool names the agent may use (e.g. ["read", "bash"]). */
  tools?: string[];
  /**
   * Dynamically include installed tools matching semantic categories. Currently
   * "search" matches grep/find/code-search style tools such as ast-grep,
   * mgrep, ffgrep, fffind, ripgrep wrappers, and pi's built-in grep/find/ls.
   */
  toolHints?: readonly AgentToolHint[];
  /**
   * Skill names to expose to this subagent. Subagents receive no skills by default.
   * When omitted, clear prompt text such as `/skill:name`, `include skill name`, or
   * `use the name skill` is treated as a natural-language opt-in. Pass [] to suppress
   * prompt inference for prompts that mention skills only as subject matter.
   */
  skills?: readonly string[];
  /**
   * typebox schema. The agent must call the validated `final_answer` tool; bounded
   * repair exhaustion throws `WorkflowStructuredOutputError` instead of returning null.
   */
  schema?: S;
}

/**
 * The primitives injected into every workflow run. A workflow is any module that
 * exports `meta` plus a default `async (api: WorkflowApi) => result`.
 */
export interface WorkflowApi {
  /** Run a schema subagent in a disposable worktree and return its structured result plus patch. */
  agent<S extends TSchema>(
    prompt: string,
    opts: AgentOptions<S> & { schema: S; isolation: "worktree" },
  ): Promise<IsolatedAgentResult<Static<S>>>;
  /** Run a text subagent in a disposable worktree and return its final text plus patch. */
  agent(prompt: string, opts: AgentOptions & { isolation: "worktree" }): Promise<IsolatedAgentResult<string>>;
  /** Run a subagent and return validated structured output; rejects with a recoverable typed error on repair exhaustion. */
  agent<S extends TSchema>(prompt: string, opts: AgentOptions<S> & { schema: S }): Promise<Static<S>>;
  /** Run a subagent and return its final assistant text. */
  agent(prompt: string, opts?: AgentOptions): Promise<string>;
  /**
   * Run another registered workflow inline as a sub-step and return its result. The child shares
   * this run's concurrency cap, abort signal, and perf sink. Nests one level only: calling
   * `workflow()` from within a sub-workflow rejects. Rejects on unknown name — catch it to handle
   * a missing sub-workflow gracefully.
   */
  workflow(ref: WorkflowRef, args?: string): Promise<unknown>;
  /**
   * Run every thunk concurrently and wait for all (a barrier). Recoverable thunk
   * failures become null slots by default; settled mode retains serialisable errors.
   */
  parallel: WorkflowParallel;
  /**
   * Run each item through all stages independently — no barrier between stages.
   * A recoverable stage failure drops that item to null and skips its later stages.
   */
  pipeline: Pipeline;
  /** Start a new phase; subsequent agents group under it in the progress tree. */
  phase(title: string): void;
  /** Emit a progress line. */
  log(message: string): void;
  /** Emit a structured progress event for native workflow UI surfaces. */
  progress(event: WorkflowProgressEvent): void;
  /** Raw argument string passed after the workflow name. */
  args: string;
  /** Working directory of the host session (typically the repo root). */
  cwd: string;
  /**
   * Token budget for the run. `budget.total` is the output-token ceiling (null when unset),
   * `spent()`/`remaining()` are live. Guard loops with `while (budget.total && budget.remaining() > N)`;
   * `agent()` throws `WorkflowBudgetExceededError` once the ceiling is reached.
   */
  budget: WorkflowBudget;
  /** Abort signal for the run, propagated from the host. */
  signal: AbortSignal | undefined;
}

export type WorkflowRun = (api: WorkflowApi) => Promise<unknown>;

export type WorkflowSourceIdentity =
  | { readonly kind: "file"; readonly path: string; readonly root: string; readonly fingerprint: string }
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "unverifiable"; readonly reason: string };

/** The authored exports of a workflow module. */
export interface WorkflowModule {
  meta: WorkflowMeta;
  default: WorkflowRun;
}

/** A validated workflow plus engine-owned provenance used for safe resume replay. */
export interface LoadedWorkflow extends WorkflowModule {
  readonly source: WorkflowSourceIdentity;
  readonly isolatedWorktreeBaseline?: WorktreeBaseline;
}
