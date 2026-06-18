import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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

export interface WorkflowRunOptions {
  inspect?: boolean;
  perf?: boolean;
  concurrency?: number;
  parallelSubmissionLimit?: number;
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
  /** Allowlist of built-in tool names the agent may use (e.g. ["read", "bash"]). */
  tools?: string[];
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
  /** Run every thunk concurrently and wait for all (a barrier). */
  parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]>;
  /** Run each item through all stages independently — no barrier between stages. */
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
  /** Abort signal for the run, propagated from the host. */
  signal: AbortSignal | undefined;
}

export type WorkflowRun = (api: WorkflowApi) => Promise<unknown>;

export interface WorkflowModule {
  meta: WorkflowMeta;
  default: WorkflowRun;
}
