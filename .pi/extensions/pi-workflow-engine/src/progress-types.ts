import type { WorkflowUsageSnapshot } from "./usage.ts";

export type AgentRowStatus = "queued" | "running" | "done" | "failed";
export type WorkflowLaneItemStatus = "pending" | "running" | "success" | "warning" | "error";

export interface AgentRowSnapshot {
  readonly id: number;
  readonly label: string;
  readonly status: AgentRowStatus;
  readonly startedAt?: number;
  readonly doneAt?: number;
  readonly toolUses: number;
  readonly lastTool?: string;
  readonly error?: string;
}

export interface PhaseSnapshot {
  readonly title: string;
  readonly agents: readonly AgentRowSnapshot[];
}

export interface WorkflowCounterSnapshot {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface WorkflowLaneItemSnapshot {
  readonly lane: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: WorkflowLaneItemStatus;
  readonly details?: string;
  readonly createdAt: number;
}

export interface WorkflowProgressSnapshot {
  readonly title: string;
  readonly startedAt: number;
  readonly doneAt?: number;
  readonly currentPhase: string;
  readonly phases: readonly PhaseSnapshot[];
  readonly counters: readonly WorkflowCounterSnapshot[];
  readonly summary: readonly [string, string | number][];
  readonly lanes: readonly [string, readonly WorkflowLaneItemSnapshot[]][];
  readonly laneOverflow: readonly [string, number][];
  readonly logs: readonly string[];
  readonly usage?: WorkflowUsageSnapshot;
}
