import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, WorkflowProgressSnapshot } from "../progress.ts";
import type { WorkflowLaneItemStatus } from "../types.ts";

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

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const sign = n < 0 ? "-" : "";
  const value = Math.abs(n);
  if (value < 1_000) return `${Math.trunc(n)}`;
  if (value < 1_000_000) return `${sign}${formatCompact(value / 1_000)}k`;
  return `${sign}${formatCompact(value / 1_000_000)}m`;
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

export function badge(label: string, color: WorkflowThemeColor, theme: Theme): string {
  return theme.fg(color, `[${label}]`);
}

export function truncateDisplay(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width);
}

export interface AgentDetailOptions {
  now?: number;
  includeQueuedStatus?: boolean;
}

export function agentDetailParts(agent: AgentRowSnapshot, now?: number): string[];
export function agentDetailParts(agent: AgentRowSnapshot, options?: AgentDetailOptions): string[];
export function agentDetailParts(agent: AgentRowSnapshot, optionsOrNow: AgentDetailOptions | number = {}): string[] {
  const options = typeof optionsOrNow === "number" ? { now: optionsOrNow } : optionsOrNow;
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

export function statusText(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  if (snapshot.doneAt !== undefined) return undefined;

  const agents = snapshot.phases.flatMap((phase) => phase.agents);
  const complete = agents.filter((agent) => agent.status === "done" || agent.status === "failed").length;
  const active = agents.filter((agent) => agent.status === "running" || agent.status === "queued").length;
  const total = agents.length;
  const kept = snapshot.counters.find((counter) => counter.key === "kept" || counter.label.toLowerCase() === "kept");
  const displayName = snapshot.title === "code-review" ? "review" : snapshot.title;

  const parts = [theme.fg("accent", displayName), theme.fg("muted", snapshot.currentPhase)];
  if (total > 0) parts.push(theme.fg("muted", `${complete}/${total}`));
  if (kept) parts.push(theme.fg("success", `${formatCount(kept.value)} kept`));
  else if (active > 0) parts.push(theme.fg("muted", `${active} active`));

  return parts.join(theme.fg("dim", " · "));
}

function formatCompact(value: number): string {
  if (value >= 100) return `${Math.round(value)}`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}` : rounded.toFixed(1);
}
