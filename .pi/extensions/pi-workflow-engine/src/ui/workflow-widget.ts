import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRowSnapshot, PhaseSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import { agentDetailParts, agentLabelColor, formatCount, formatDuration, statusIcon, truncateDisplay } from "./workflow-format.ts";

const MAX_WIDGET_LINES = 12;

export function renderWorkflowWidgetLines(
  snapshot: WorkflowProgressSnapshot,
  width: number,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, width);
  const counts = countAgents(snapshot.phases);
  const active = counts.running + counts.queued;
  const elapsed = formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt);
  const activity = active > 0 ? theme.fg("accent", "●") : theme.fg("success", "✓");

  const headingParts = [`${counts.done}/${counts.total} done`, elapsed];
  if (counts.running > 0) headingParts.unshift(`${counts.running} running`);
  if (counts.queued > 0) headingParts.unshift(`${counts.queued} queued`);
  if (counts.failed > 0) headingParts.unshift(theme.fg("error", `${counts.failed} failed`));

  const lines: string[] = [
    truncateDisplay(
      `${activity} ${theme.bold(snapshot.title)} ${theme.fg("dim", "·")} ${theme.fg("muted", snapshot.currentPhase)} ${theme.fg("dim", "·")} ${headingParts.join(` ${theme.fg("dim", "·")} `)}`,
      safeWidth,
    ),
  ];

  const footer = footerLine(snapshot, theme);
  const bodyBudget = Math.max(0, MAX_WIDGET_LINES - lines.length - (footer ? 1 : 0));
  const body = visibleBodyLines(snapshot.phases, bodyBudget, theme);
  const reserveHiddenLine = body.hidden > 0 && bodyBudget > 0;
  const visibleBodyLinesToRender = reserveHiddenLine ? body.lines.slice(0, Math.max(0, bodyBudget - 1)) : body.lines;
  const hidden = body.hidden + (body.lines.length - visibleBodyLinesToRender.length);

  for (const line of visibleBodyLinesToRender) lines.push(truncateDisplay(line, safeWidth));
  if (hidden > 0 && lines.length < MAX_WIDGET_LINES) {
    lines.push(truncateDisplay(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`, safeWidth));
  }
  if (footer && lines.length < MAX_WIDGET_LINES) lines.push(truncateDisplay(footer, safeWidth));

  return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateDisplay(line, safeWidth));
}

interface AgentCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  total: number;
}

function countAgents(phases: readonly PhaseSnapshot[]): AgentCounts {
  const counts: AgentCounts = { queued: 0, running: 0, done: 0, failed: 0, total: 0 };
  for (const phase of phases) {
    for (const agent of phase.agents) {
      counts[agent.status]++;
      counts.total++;
    }
  }
  return counts;
}

function visibleBodyLines(phases: readonly PhaseSnapshot[], budget: number, theme: Theme): { lines: string[]; hidden: number } {
  const lines: string[] = [];
  let totalRows = 0;
  const visit = (phase: PhaseSnapshot): void => {
    if (phase.agents.length === 0 && phase.title === "Workflow") return;
    const counts = countPhaseAgents(phase);
    totalRows++;
    if (lines.length < budget) lines.push(phaseLine(phase.title, counts, theme));
    appendAgentGroup(phase.agents, (agent) => agent.status === "running" || agent.status === "queued", lines, budget, theme, () => totalRows++);
    appendAgentGroup(phase.agents, (agent) => agent.status === "failed", lines, budget, theme, () => totalRows++);
    appendAgentGroup(phase.agents, (agent) => agent.status === "done", lines, budget, theme, () => totalRows++);
  };

  for (const phase of phases) {
    if (phase.agents.some((agent) => agent.status === "running" || agent.status === "queued")) visit(phase);
  }
  for (const phase of phases) {
    if (!phase.agents.some((agent) => agent.status === "running" || agent.status === "queued")) visit(phase);
  }

  return { lines, hidden: Math.max(0, totalRows - lines.length) };
}

function appendAgentGroup(
  agents: readonly AgentRowSnapshot[],
  include: (agent: AgentRowSnapshot) => boolean,
  lines: string[],
  budget: number,
  theme: Theme,
  countRow: () => void,
): void {
  for (const agent of agents) {
    if (!include(agent)) continue;
    countRow();
    if (lines.length < budget) lines.push(agentLine(agent, theme));
  }
}

function countPhaseAgents(phase: PhaseSnapshot): AgentCounts {
  const counts: AgentCounts = { queued: 0, running: 0, done: 0, failed: 0, total: phase.agents.length };
  for (const agent of phase.agents) counts[agent.status]++;
  return counts;
}

function phaseLine(title: string, counts: AgentCounts, theme: Theme): string {
  const parts: string[] = [];
  if (counts.running > 0) parts.push(`${counts.running} running`);
  if (counts.done > 0) parts.push(`${counts.done} done`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  return `${theme.fg("dim", "├─")} ${theme.fg(counts.running > 0 ? "accent" : "muted", title)}${parts.length ? ` ${theme.fg("dim", `(${parts.join(" · ")})`)}` : ""}`;
}

function agentLine(agent: AgentRowSnapshot, theme: Theme): string {
  const detailParts = agentDetailParts(agent, { includeQueuedStatus: false });
  const activity = detailParts.length > 0 ? ` ${theme.fg("dim", `· ${detailParts.join(" · ")}`)}` : "";
  return `${theme.fg("dim", "│  ")} ${statusIcon(agent.status, theme)} ${theme.fg(agentLabelColor(agent), agent.label)}${activity}`;
}

function footerLine(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const usage = formatWorkflowUsageLine(snapshot.usage);
  const counters = snapshot.counters.slice(0, 4).map((counter) => `${counter.label} ${formatCount(counter.value)}`);
  const latestLog = snapshot.logs[snapshot.logs.length - 1];
  const parts = usage ? [usage, ...counters] : counters;
  if (latestLog) parts.push(latestLog);
  if (parts.length === 0) return undefined;
  return `${theme.fg("dim", "└─")} ${theme.fg("dim", parts.join(" · "))}`;
}
