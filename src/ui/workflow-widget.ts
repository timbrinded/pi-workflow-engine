import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRowSnapshot, PhaseSnapshot, WorkflowProgressSnapshot } from "../progress.ts";
import { agentDetailParts, agentLabelColor, formatCount, formatDuration, statusIcon, truncateDisplay } from "./workflow-format.ts";

const MAX_WIDGET_LINES = 12;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface WorkflowWidget {
  nextFrame(): void;
  render(width: number, theme: Theme): string[];
  invalidate(): void;
}

export function createWorkflowWidget(snapshotProvider: () => WorkflowProgressSnapshot): WorkflowWidget {
  return new LiveWorkflowWidget(snapshotProvider);
}

function renderWorkflowWidgetLines(
  snapshot: WorkflowProgressSnapshot,
  frame: number,
  width: number,
  theme: Theme,
): string[] {
  const safeWidth = Math.max(1, width);
  const agents = snapshot.phases.flatMap((phase) => phase.agents);
  const running = agents.filter((agent) => agent.status === "running").length;
  const queued = agents.filter((agent) => agent.status === "queued").length;
  const done = agents.filter((agent) => agent.status === "done").length;
  const failed = agents.filter((agent) => agent.status === "failed").length;
  const active = running + queued;
  const elapsed = formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt);
  const spinner = active > 0 ? theme.fg("accent", SPINNER[frame % SPINNER.length]) : theme.fg("success", "✓");

  const headingParts = [`${done}/${agents.length} done`, elapsed];
  if (running > 0) headingParts.unshift(`${running} running`);
  if (queued > 0) headingParts.unshift(`${queued} queued`);
  if (failed > 0) headingParts.unshift(theme.fg("error", `${failed} failed`));

  const lines: string[] = [
    truncateDisplay(
      `${spinner} ${theme.bold(snapshot.title)} ${theme.fg("dim", "·")} ${theme.fg("muted", snapshot.currentPhase)} ${theme.fg("dim", "·")} ${headingParts.join(` ${theme.fg("dim", "·")} `)}`,
      safeWidth,
    ),
  ];

  const footer = footerLine(snapshot, theme);
  const bodyBudget = Math.max(0, MAX_WIDGET_LINES - lines.length - (footer ? 1 : 0));
  const bodyLines = prioritizedBodyLines(snapshot.phases, theme);
  const visibleBody = bodyLines.slice(0, bodyBudget);
  const hidden = bodyLines.length - visibleBody.length;

  for (const line of visibleBody) lines.push(truncateDisplay(line, safeWidth));
  if (hidden > 0 && lines.length < MAX_WIDGET_LINES) {
    lines.push(truncateDisplay(`${theme.fg("dim", "└─")} ${theme.fg("dim", `+${hidden} more`)}`, safeWidth));
  }
  if (footer && lines.length < MAX_WIDGET_LINES) lines.push(truncateDisplay(footer, safeWidth));

  return lines.slice(0, MAX_WIDGET_LINES).map((line) => truncateDisplay(line, safeWidth));
}

class LiveWorkflowWidget implements WorkflowWidget {
  private frame = 0;
  private cachedWidth: number | undefined;
  private cachedFrame: number | undefined;
  private cachedDoneAt: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(private readonly snapshotProvider: () => WorkflowProgressSnapshot) {}

  nextFrame(): void {
    this.frame = (this.frame + 1) % SPINNER.length;
    this.invalidate();
  }

  render(width: number, theme: Theme): string[] {
    const snapshot = this.snapshotProvider();
    if (
      this.cachedLines &&
      this.cachedWidth === width &&
      this.cachedFrame === this.frame &&
      this.cachedDoneAt === snapshot.doneAt
    ) {
      return this.cachedLines;
    }

    this.cachedLines = renderWorkflowWidgetLines(snapshot, this.frame, width, theme);
    this.cachedWidth = width;
    this.cachedFrame = this.frame;
    this.cachedDoneAt = snapshot.doneAt;
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedFrame = undefined;
    this.cachedDoneAt = undefined;
    this.cachedLines = undefined;
  }
}

function prioritizedBodyLines(phases: readonly PhaseSnapshot[], theme: Theme): string[] {
  const activePhases = phases.filter((phase) => phase.agents.some((agent) => agent.status === "running" || agent.status === "queued"));
  const inactivePhases = phases.filter((phase) => !activePhases.includes(phase));
  return [...activePhases, ...inactivePhases].flatMap((phase) => phaseLines(phase, theme));
}

function phaseLines(phase: PhaseSnapshot, theme: Theme): string[] {
  if (phase.agents.length === 0 && phase.title === "Workflow") return [];
  const running = phase.agents.filter((agent) => agent.status === "running").length;
  const done = phase.agents.filter((agent) => agent.status === "done").length;
  const failed = phase.agents.filter((agent) => agent.status === "failed").length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);

  const lines = [`${theme.fg("dim", "├─")} ${theme.fg(running > 0 ? "accent" : "muted", phase.title)}${parts.length ? ` ${theme.fg("dim", `(${parts.join(" · ")})`)}` : ""}`];
  const active = phase.agents.filter((agent) => agent.status === "running" || agent.status === "queued");
  const failedAgents = phase.agents.filter((agent) => agent.status === "failed");
  const completed = phase.agents.filter((agent) => agent.status === "done");
  for (const agent of [...active, ...failedAgents, ...completed]) lines.push(agentLine(agent, theme));
  return lines;
}

function agentLine(agent: AgentRowSnapshot, theme: Theme): string {
  const detailParts = agentDetailParts(agent, { includeQueuedStatus: false });
  const activity = detailParts.length > 0 ? ` ${theme.fg("dim", `· ${detailParts.join(" · ")}`)}` : "";
  return `${theme.fg("dim", "│  ")} ${statusIcon(agent.status, theme)} ${theme.fg(agentLabelColor(agent), agent.label)}${activity}`;
}

function footerLine(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const counters = snapshot.counters.slice(0, 4).map((counter) => `${counter.label} ${formatCount(counter.value)}`);
  const latestLog = snapshot.logs[snapshot.logs.length - 1];
  const parts = counters.length > 0 ? counters : [];
  if (latestLog) parts.push(latestLog);
  if (parts.length === 0) return undefined;
  return `${theme.fg("dim", "└─")} ${theme.fg("dim", parts.join(" · "))}`;
}
