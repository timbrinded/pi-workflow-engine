import type { Static, TSchema } from "typebox";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Pipeline } from "./concurrency.ts";

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
  /** Model id (e.g. "claude-opus-4-5"); omit to inherit the host's current model. */
  model?: string;
  /** Reasoning effort for this agent. */
  thinkingLevel?: ThinkingLevel;
  /** Allowlist of built-in tool names the agent may use (e.g. ["read", "bash"]). */
  tools?: string[];
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
