import type { Api, Model } from "@earendil-works/pi-ai";
import type { CreateAgentSessionOptions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { WorkflowBudget } from "./budget.ts";
import type { Semaphore } from "./concurrency.ts";
import type { WorkflowAgentLimiter } from "./agent-limits.ts";
import type { AgentRetryScheduler } from "./agent-retry.ts";
import type { ResolvedWorkflowModelProfiles } from "./model-profiles.ts";
import type { WorkflowJournal } from "./journal.ts";
import type { PerfSink } from "./perf.ts";
import type { AgentOptions, WorkflowProgressEvent } from "./types.ts";
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
  getAllTools(): readonly AgentRunnerToolInfo[];
  getActiveToolNames(): readonly string[];
  getToolDefinition(name: string): EffectiveToolDefinitionLike | undefined;
  setActiveToolsByName(toolNames: readonly string[]): void;
  setAutoRetryEnabled(enabled: boolean): void;
  getLastAssistantText(): string | undefined;
}

export type CreateAgentSession = (options: CreateAgentSessionOptions) => Promise<{ session: AgentRunnerSession }>;

export interface AgentProgress {
  agentQueued(phase: string | undefined, label: string): number;
  agentStart(phase: string | undefined, label: string, id?: number): void;
  agentTool(label: string, tool: string, id?: number): void;
  agentDone(label: string, id?: number): void;
  agentFailed(label: string, error: unknown, id?: number): void;
  event(event: WorkflowProgressEvent): void;
  log(message: string): void;
}

interface RunContextBase {
  cwd: string;
  hostModel: Model<Api> | undefined;
  semaphore: Semaphore;
  agentLimiter: WorkflowAgentLimiter;
  agentTimeoutMs: number;
  agentRetries: number;
  pauseOnProviderUsageLimit?: boolean;
  resumeEditedWorkflow?: boolean;
  retryScheduler: AgentRetryScheduler;
  modelProfiles: ResolvedWorkflowModelProfiles;
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
      /** Production sessions share one lazily-created model runtime for this workflow run. */
      modelRegistry: ModelRegistry;
      getModelRuntime: () => Promise<ModelRuntime>;
      createSession?: undefined;
    }
  | {
      /** Injected test sessions bypass Pi's resource loader and therefore do not resolve skills. */
      modelRegistry: Pick<ModelRegistry, "find">;
      getModelRuntime?: undefined;
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
