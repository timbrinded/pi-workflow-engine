import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { WorkflowBudget } from "./budget.ts";
import type { Semaphore } from "./concurrency.ts";
import type { WorkflowAgentLimiter } from "./agent-limits.ts";
import type { WorkflowJournal } from "./journal.ts";
import type { PerfSink } from "./perf.ts";
import type { AgentOptions } from "./types.ts";
import type { WorkflowUsageSink } from "./usage.ts";
import type { WorktreeBaseline, WorktreeRegistry } from "./worktree.ts";
import type {
  EffectiveAgentModelLike,
  EffectiveToolDefinitionLike,
} from "./agent-session-identity.ts";

export interface AgentRunnerEvent {
  readonly type: string;
  readonly toolName?: string;
}

export interface AgentRunnerToolInfo {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly promptGuidelines?: readonly string[];
  readonly sourceInfo?: {
    readonly path: string;
    readonly source: string;
    readonly scope: string;
    readonly origin: string;
    readonly baseDir?: string;
  };
}

export interface AgentRunnerSession {
  readonly state: {
    readonly messages: readonly unknown[];
    readonly systemPrompt?: string;
    readonly model?: EffectiveAgentModelLike;
    readonly thinkingLevel?: string;
  };
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentRunnerEvent) => void): () => void;
  dispose(): void;
  abort(): Promise<void>;
  getAllTools?(): readonly AgentRunnerToolInfo[];
  getActiveToolNames?(): readonly string[];
  getToolDefinition?(name: string): EffectiveToolDefinitionLike | undefined;
  setActiveToolsByName?(toolNames: readonly string[]): void;
}

type InjectedAgentSessionOptions = Omit<CreateAgentSessionOptions, "modelRegistry"> & {
  readonly modelRegistry: Pick<ModelRegistry, "find">;
};

export type CreateAgentSession = (options: InjectedAgentSessionOptions) => Promise<{ session: AgentRunnerSession }>;

export interface AgentProgress {
  agentQueued(phase: string | undefined, label: string): number;
  agentStart(phase: string | undefined, label: string, id?: number): void;
  agentTool(label: string, tool: string, id?: number): void;
  agentDone(label: string, id?: number): void;
  agentFailed(label: string, error: unknown, id?: number): void;
  log(message: string): void;
}

interface RunContextBase {
  cwd: string;
  hostModel: Model<Api> | undefined;
  semaphore: Semaphore;
  agentLimiter: WorkflowAgentLimiter;
  agentTimeoutMs: number;
  progress: AgentProgress;
  signal: AbortSignal | undefined;
  perf: PerfSink;
  usage: WorkflowUsageSink;
  budget: WorkflowBudget;
  journal: WorkflowJournal;
  worktrees: WorktreeRegistry;
}

/** Shared per-run context threaded into every agent() call. */
export type RunContext = RunContextBase & (
  | {
      /** The real session factory requires the complete pi model registry. */
      modelRegistry: ModelRegistry;
      createSession?: undefined;
    }
  | {
      /** Tests and other injected factories may deliberately consume only model lookup. */
      modelRegistry: Pick<ModelRegistry, "find">;
      createSession: CreateAgentSession;
    }
);

/** Runtime-only options. The authored WorkflowApi exposes only AgentOptions. */
export type AgentExecutionOptions = AgentOptions & {
  readonly worktreeBaseline?: WorktreeBaseline;
};

export interface AgentRunTags {
  readonly [key: string]: string | number;
  readonly label: string;
  readonly phase: string;
}
