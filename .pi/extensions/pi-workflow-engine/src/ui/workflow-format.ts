import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, PhaseSnapshot, WorkflowLaneItemStatus, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatCount } from "../text.ts";
import { formatWorkflowUsageLine } from "../usage.ts";

export type WorkflowDisplayStatus = WorkflowLaneItemStatus | "queued" | "done" | "failed";
export type WorkflowThemeColor = Parameters<Theme["fg"]>[0];

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1_000) return `${Math.round(ms)}ms`;

  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours}h` : `${hours}h ${remainingMinutes}m`;
}

export function statusIcon(status: WorkflowDisplayStatus, theme: Theme): string {
  switch (status) {
    case "success":
    case "done":
      return theme.fg("success", "✓");
    case "warning":
      return theme.fg("warning", "!");
    case "error":
    case "failed":
      return theme.fg("error", "✗");
    case "running":
      return theme.fg("accent", "●");
    case "queued":
    case "pending":
      return theme.fg("dim", "○");
  }
}

export function truncateDisplay(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width);
}

export interface AgentDetailOptions {
  now?: number;
  includeQueuedStatus?: boolean;
}

export function agentDetailParts(agent: AgentRowSnapshot, options: AgentDetailOptions = {}): string[] {
  const now = options.now ?? Date.now();
  const includeQueuedStatus = options.includeQueuedStatus ?? true;
  const parts: string[] = [];
  if (agent.toolUses > 0) parts.push(`${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}`);
  if (agent.lastTool) parts.push(agent.lastTool);
  if (agent.startedAt !== undefined) parts.push(formatDuration((agent.doneAt ?? now) - agent.startedAt));
  else if (includeQueuedStatus && agent.status === "queued") parts.push("queued");
  if (agent.status === "failed" && agent.error) parts.push(agent.error);
  return parts;
}

export function agentLabelColor(agent: AgentRowSnapshot): WorkflowThemeColor {
  return agent.status === "running" ? "text" : "muted";
}

export interface WorkflowStatusCounts {
  readonly queued: number;
  readonly running: number;
  readonly done: number;
  readonly failed: number;
  readonly total: number;
}

interface WorkflowInspectionSource {
  readonly name: string;
  readonly snapshot: WorkflowProgressSnapshot | (() => WorkflowProgressSnapshot);
}

export function workflowInspectionSnapshot(inspection: WorkflowInspectionSource): WorkflowProgressSnapshot {
  return typeof inspection.snapshot === "function" ? inspection.snapshot() : inspection.snapshot;
}

export function formatWorkflowInspection(inspection: WorkflowInspectionSource): string {
  const snapshot = workflowInspectionSnapshot(inspection);
  const counts = countAgents(snapshot.phases);
  const lines = [
    `Workflow inspector: ${inspection.name}`,
    `Run: ${snapshot.runId}`,
    `Phase: ${snapshot.currentPhase}`,
    `Agents: ${counts.running} running, ${counts.queued} queued, ${counts.done} done, ${counts.failed} failed`,
  ];
  const usage = formatWorkflowUsageLine(snapshot.usage);
  if (usage) lines.push(usage);
  if (snapshot.logs.length > 0) lines.push("Recent log:", ...snapshot.logs.slice(-8).map((entry) => `- ${entry}`));
  return lines.join("\n");
}

export function statusTextFromCounts(snapshot: WorkflowProgressSnapshot, counts: WorkflowStatusCounts, theme: Theme): string | undefined {
  if (snapshot.doneAt !== undefined) return undefined;

  const complete = counts.done + counts.failed;
  const active = counts.running + counts.queued;
  const kept = snapshot.counters.find((counter) => counter.key === "kept" || counter.label.toLowerCase() === "kept");
  const displayName = snapshot.title === "code-review" ? "review" : snapshot.title;

  const parts = [theme.fg("accent", displayName), theme.fg("muted", snapshot.currentPhase)];
  if (counts.total > 0) parts.push(theme.fg("muted", `${complete}/${counts.total}`));
  if (kept) parts.push(theme.fg("success", `${formatCount(kept.value)} kept`));
  else if (active > 0) parts.push(theme.fg("muted", `${active} active`));

  return parts.join(theme.fg("dim", " · "));
}

export function countAgents(phases: readonly PhaseSnapshot[]): WorkflowStatusCounts {
  const counts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
  for (const phase of phases) {
    for (const agent of phase.agents) {
      counts[agent.status]++;
      counts.total++;
    }
  }
  return counts;
}
