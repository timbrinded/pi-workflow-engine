import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { WorkflowBudget } from "./budget.ts";
import type { Pipeline } from "./concurrency.ts";
import type { PerfSink, PerfSnapshot } from "./perf.ts";
import type { WorkflowProgressSnapshot } from "./progress.ts";
import type { WorkflowUsageSnapshot } from "./usage.ts";

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
  /** Output-token ceiling for the whole run. Omit for no limit (budget.total === null). */
  budget?: number;
  /** Internal/test override for the generated run id. Omit to generate a new id. */
  runId?: string;
  /** Replay completed agent results from this prior run id when prompt/options hashes still match. */
  resumeFromRunId?: string;
  resultViewer?: "open" | "skip";
  /** Additional abort signal to compose with the host context signal. */
  signal?: AbortSignal;
  /** Internal recorder override for command/tool invocation timing. */
  perfRecorder?: PerfSink;
  /** Resolve a sub-workflow reference to a module, enabling `api.workflow()`. When omitted, `api.workflow()` throws. */
  resolveWorkflow?: (ref: WorkflowRef) => Promise<WorkflowModule>;
  /** Called with the final performance snapshot when perf is enabled. */
  onPerfSnapshot?: (snapshot: PerfSnapshot) => void;
  /** Called with the final workflow subagent usage snapshot. */
  onUsageSnapshot?: (snapshot: WorkflowUsageSnapshot) => void;
  /** Called once run identity and journal paths are known. */
  onRunMetadata?: (metadata: WorkflowRunMetadata) => void;
  /** Called with the live progress source while a workflow is running, then undefined when it ends. */
  onProgressSource?: (source: WorkflowProgressSource | undefined) => void;
  /** Called with the final completed progress snapshot after live workflow UI teardown. */
  onProgressSnapshot?: (snapshot: WorkflowProgressSnapshot) => void;
}

export interface WorkflowProgressSource {
  snapshot(): WorkflowProgressSnapshot;
}

/** Options for a single `agent()` call. */
export type WorkflowLaneItemStatus = "pending" | "running" | "success" | "warning" | "error";

export type AgentToolHint = "search";

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
  /** typebox schema. When set, the agent is forced to return matching structured data. */
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
  ): Promise<IsolatedAgentResult<Static<S> | null>>;
  /** Run a text subagent in a disposable worktree and return its final text plus patch. */
  agent(prompt: string, opts: AgentOptions & { isolation: "worktree" }): Promise<IsolatedAgentResult<string>>;
  /** Run a subagent and return its validated structured output (null if it never produced one). */
  agent<S extends TSchema>(prompt: string, opts: AgentOptions<S> & { schema: S }): Promise<Static<S> | null>;
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
   * failures become null slots; filter nulls before consuming survivors.
   */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
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

export interface WorkflowModule {
  meta: WorkflowMeta;
  default: WorkflowRun;
}
