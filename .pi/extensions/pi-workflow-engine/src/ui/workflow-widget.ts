import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, PhaseSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatCount } from "../text.ts";
import { compactUsage, dot, fit, GLYPH, joinParts, keyHints, progressBar, spread, type ThemeColor } from "./kit.ts";
import { countAgents, formatDuration, formatElapsed, type WorkflowStatusCounts } from "./workflow-format.ts";

/** pi caps string widgets at this many rows; the component keeps to the same budget. */
const MAX_WIDGET_LINES = 10;
/** Width used for surfaces that only accept pre-rendered strings (RPC). */
export const STRING_WIDGET_WIDTH = 100;

const INSPECTOR_COMMAND = "/workflow:inspector";
const MAX_BAR_WIDTH = 24;
const MIN_BAR_WIDTH = 8;
const MAX_PHASE_COLUMN = 18;
const MAX_LABEL_COLUMN = 26;
const FAILURE_LOG = /\b(fail(ed|ure|ing)?|error)\b/i;

let inspectorShortcut: string | null = null;

/** The widget footer names the configured inspector shortcut; registration sets it once from the shortcut config. */
export function setWorkflowInspectorShortcut(shortcut: string | null): void {
  inspectorShortcut = shortcut;
}

function workflowInspectorHint(): string {
  return inspectorShortcut ?? INSPECTOR_COMMAND;
}

/**
 * The live run widget, every line fitted to `width`:
 * header (name, bar, finished/total, elapsed, usage) → phases in chronological order, the active
 * phase expanded into agent rows → upcoming declared phases → counters with the inspector hint.
 */
export function renderWorkflowWidget(snapshot: WorkflowProgressSnapshot, width: number, theme: Theme): string[] {
  const now = Date.now();
  const inner = Math.max(1, width - 2);
  const counts = countAgents(snapshot.phases);
  const phases = classifyPhases(snapshot);
  const failureLog = failureLogLine(snapshot, theme);
  const footer = footerLine(snapshot, workflowInspectorHint(), inner, theme);
  const upcoming = upcomingLine(snapshot, theme);

  const bodyBudget = MAX_WIDGET_LINES - 2 - (failureLog ? 1 : 0);
  const body = phaseBody(phases, upcoming, bodyBudget, inner, now, theme);
  const lines = [headerLine(snapshot, counts, inner, now, theme), ...body];
  if (failureLog) lines.push(failureLog);
  lines.push(footer);
  return lines.map((line) => ` ${truncateToWidth(line, inner, "…")}`);
}

/** A TUI widget that re-renders its lines at the terminal's current width on every frame. */
export class WidthAwareWidget implements Component {
  constructor(private readonly lines: (width: number) => string[]) {}

  render(width: number): string[] {
    return this.lines(width);
  }

  invalidate(): void {}
}

/** `◆ background · code-review 56b57550 · Find 6/10 · 12s`: one line for a run the user sent to the background. */
export function renderBackgroundWorkflowLine(snapshot: WorkflowProgressSnapshot, width: number, theme: Theme): string[] {
  const counts = countAgents(snapshot.phases);
  const progress = counts.total > 0 ? `${snapshot.currentPhase} ${counts.done + counts.failed}/${counts.total}` : snapshot.currentPhase;
  const line = joinParts([
    `${theme.fg("accent", GLYPH.workflow)} ${theme.fg("muted", "background")}`,
    `${theme.bold(snapshot.title)} ${theme.fg("dim", snapshot.runId.slice(0, 8))}`,
    theme.fg("muted", progress),
    counts.failed > 0 ? theme.fg("error", `${counts.failed} failed`) : undefined,
    theme.fg("dim", formatElapsed(Date.now() - snapshot.startedAt)),
  ], theme);
  return [` ${spread(line, keyHints([[workflowInspectorHint(), "inspect"]], theme), Math.max(1, width - 2))}`];
}

interface ClassifiedPhases {
  /** Every shown phase in chronological order; finished and active phases interleave when pipelines overlap. */
  readonly ordered: readonly PhaseSnapshot[];
  /** The current phase plus any phase that still has running or queued agents. */
  readonly active: readonly PhaseSnapshot[];
}

function classifyPhases(snapshot: WorkflowProgressSnapshot): ClassifiedPhases {
  // The implicit "Workflow" bucket only matters when agents ran before any phase() call.
  const ordered = snapshot.phases.filter((phase) => phase.agents.length > 0 || phase.title !== "Workflow");
  const active = ordered.filter((phase) =>
    phase.title === snapshot.currentPhase || phase.agents.some((agent) => agent.status === "running" || agent.status === "queued"));
  return { ordered, active };
}

function headerLine(snapshot: WorkflowProgressSnapshot, counts: WorkflowStatusCounts, width: number, now: number, theme: Theme): string {
  const name = `${theme.fg("accent", GLYPH.workflow)} ${theme.bold(snapshot.title)}`;
  const finished = counts.done + counts.failed;
  const stats = joinParts([
    counts.total > 0 ? theme.fg("text", `${finished}/${counts.total}`) : undefined,
    theme.fg("muted", formatElapsed(now - snapshot.startedAt)),
    compactUsage(snapshot.usage, theme),
  ], theme);
  const barWidth = Math.min(MAX_BAR_WIDTH, width - visibleWidth(name) - visibleWidth(stats) - 4);
  if (counts.total === 0 || barWidth < MIN_BAR_WIDTH) return `${name}  ${stats}`;
  return `${name}  ${progressBar(finished, counts.total, barWidth, theme)}  ${stats}`;
}

interface AgentRowPlan {
  readonly phase: PhaseSnapshot;
  readonly shown: readonly AgentRowSnapshot[];
  readonly hidden: number;
}

function phaseBody(
  phases: ClassifiedPhases,
  upcoming: string | undefined,
  budget: number,
  width: number,
  now: number,
  theme: Theme,
): string[] {
  let ordered: readonly (PhaseSnapshot | "collapsed")[] = phases.ordered;
  const candidates = phases.active.reduce((total, phase) => total + phase.agents.length, 0);
  const wantedRows = Math.min(candidates, 3);
  const fixedLines = () => ordered.length + (upcoming ? 1 : 0);
  // Keep agent rows visible on long workflows: fold everything finished before the first active phase into one line.
  if (budget - fixedLines() < wantedRows) {
    const firstActive = phases.ordered.findIndex((phase) => phases.active.includes(phase));
    const foldUntil = firstActive === -1 ? phases.ordered.length : firstActive;
    if (foldUntil > 1) ordered = ["collapsed", ...phases.ordered.slice(foldUntil)];
  }
  const showUpcoming = upcoming !== undefined && budget - ordered.length >= 1;
  const rowBudget = Math.max(0, budget - ordered.length - (showUpcoming ? 1 : 0));
  const plans = planAgentRows(phases.active, rowBudget);

  const visiblePhases = ordered.filter((entry): entry is PhaseSnapshot => entry !== "collapsed");
  const titleWidth = Math.min(MAX_PHASE_COLUMN, Math.max(0, ...visiblePhases.map((phase) => visibleWidth(phase.title))));
  const labelWidth = agentLabelWidth(plans, width);
  const folded = phases.ordered.slice(0, phases.ordered.length - visiblePhases.length);

  const lines: string[] = [];
  for (const entry of ordered) {
    if (entry === "collapsed") {
      lines.push(foldedPhasesLine(folded, theme));
      continue;
    }
    const plan = plans.get(entry);
    if (!plan) {
      lines.push(finishedPhaseLine(entry, titleWidth, theme));
      continue;
    }
    lines.push(activePhaseLine(plan, titleWidth, theme));
    for (const agent of plan.shown) lines.push(agentLine(agent, entry, labelWidth, width, now, theme));
  }
  if (showUpcoming && upcoming) lines.push(upcoming);
  return lines.slice(0, budget);
}

/**
 * Spread the row budget over active phases by importance — a reserved share for failures so they always
 * show, then running, remaining failures, done, queued — while each phase lists its chosen rows as
 * running, failed, done, queued.
 */
function planAgentRows(active: readonly PhaseSnapshot[], budget: number): Map<PhaseSnapshot, AgentRowPlan> {
  const byStatus = (status: AgentRowSnapshot["status"]) =>
    active.flatMap((phase) => phase.agents.filter((agent) => agent.status === status));
  const failed = byStatus("failed");
  const chosen = new Set<AgentRowSnapshot>();
  let remaining = budget;
  const take = (agents: readonly AgentRowSnapshot[], limit = remaining) => {
    for (const agent of agents) {
      if (remaining <= 0 || limit <= 0) return;
      if (chosen.has(agent)) continue;
      chosen.add(agent);
      remaining--;
      limit--;
    }
  };
  take(failed, failed.length > 0 ? Math.max(1, Math.floor(budget / 3)) : 0);
  take(byStatus("running"));
  take(failed);
  take(byStatus("done"));
  take(byStatus("queued"));

  const rank = { running: 0, failed: 1, done: 2, queued: 3 } as const;
  const plans = new Map<PhaseSnapshot, AgentRowPlan>();
  for (const phase of active) {
    const shown = phase.agents.filter((agent) => chosen.has(agent)).sort((a, b) => rank[a.status] - rank[b.status]);
    plans.set(phase, { phase, shown, hidden: phase.agents.length - shown.length });
  }
  return plans;
}

function agentLabelWidth(plans: ReadonlyMap<PhaseSnapshot, AgentRowPlan>, width: number): number {
  const labels = [...plans.values()].flatMap((plan) => plan.shown.map((agent) => visibleWidth(agentLabel(agent, plan.phase))));
  return Math.min(MAX_LABEL_COLUMN, Math.floor(width * 0.4), Math.max(0, ...labels));
}

function finishedPhaseLine(phase: PhaseSnapshot, titleWidth: number, theme: Theme): string {
  const counts = countAgents([phase]);
  const glyph = counts.failed === 0
    ? theme.fg("success", GLYPH.done)
    : counts.failed === counts.total ? theme.fg("error", GLYPH.failed) : theme.fg("warning", GLYPH.warning);
  const span = phaseSpan(phase.agents);
  const detail = joinParts([
    counts.total > 0 ? theme.fg("muted", plural(counts.total, "agent")) : undefined,
    span === undefined ? undefined : theme.fg("muted", shortDuration(span)),
    counts.failed > 0 ? theme.fg("error", `${counts.failed} failed`) : undefined,
  ], theme);
  return `  ${glyph} ${theme.fg("muted", fit(phase.title, titleWidth))}  ${detail}`.trimEnd();
}

function foldedPhasesLine(phases: readonly PhaseSnapshot[], theme: Theme): string {
  const counts = countAgents(phases);
  const glyph = counts.failed > 0 ? theme.fg("warning", GLYPH.warning) : theme.fg("success", GLYPH.done);
  const titles = phases.map((phase) => phase.title).join(" · ");
  const detail = joinParts([
    theme.fg("muted", plural(counts.total, "agent")),
    counts.failed > 0 ? theme.fg("error", `${counts.failed} failed`) : undefined,
  ], theme);
  return `  ${glyph} ${theme.fg("muted", titles)}  ${detail}`;
}

function activePhaseLine(plan: AgentRowPlan, titleWidth: number, theme: Theme): string {
  const counts = countAgents([plan.phase]);
  const detail = joinParts([
    counts.running > 0 ? theme.fg("accent", `${counts.running} running`) : undefined,
    counts.queued > 0 ? theme.fg("muted", `${counts.queued} queued`) : undefined,
    counts.done > 0 ? theme.fg("muted", `${counts.done} done`) : undefined,
    counts.failed > 0 ? theme.fg("error", `${counts.failed} failed`) : undefined,
    plan.hidden > 0 ? theme.fg("dim", `+${plan.hidden} more`) : undefined,
  ], theme);
  return `  ${theme.fg("accent", GLYPH.running)} ${theme.bold(fit(plan.phase.title, titleWidth))}  ${detail}`.trimEnd();
}

function agentLine(agent: AgentRowSnapshot, phase: PhaseSnapshot, labelWidth: number, width: number, now: number, theme: Theme): string {
  const glyph = agentGlyph(agent, theme);
  const label = fit(agentLabel(agent, phase), labelWidth);
  const head = `    ${glyph} ${theme.fg(agent.status === "running" || agent.status === "failed" ? "text" : "muted", label)}  `;
  return head + truncateToWidth(agentDetail(agent, now, theme), Math.max(0, width - visibleWidth(head)), "…");
}

function agentGlyph(agent: AgentRowSnapshot, theme: Theme): string {
  switch (agent.status) {
    case "running":
      return theme.fg("accent", GLYPH.running);
    case "failed":
      return theme.fg("error", GLYPH.failed);
    case "done":
      return theme.fg("success", GLYPH.done);
    case "queued":
      return theme.fg("dim", GLYPH.queued);
  }
}

/** Running: what it is doing now; done: how much it did; failed: why. */
function agentDetail(agent: AgentRowSnapshot, now: number, theme: Theme): string {
  const elapsed = agent.startedAt === undefined ? undefined : (agent.doneAt ?? now) - agent.startedAt;
  switch (agent.status) {
    case "running":
      return joinParts([agent.lastTool && theme.fg("muted", agent.lastTool), elapsed !== undefined && theme.fg("dim", formatElapsed(elapsed))], theme);
    case "done":
      return joinParts([
        agent.toolUses > 0 && theme.fg("dim", plural(agent.toolUses, "tool")),
        elapsed !== undefined && theme.fg("dim", shortDuration(elapsed)),
      ], theme);
    case "failed":
      return theme.fg("error", oneLine(agent.error ?? "failed"));
    case "queued":
      return theme.fg("dim", "queued");
  }
}

/** `find:logic-bugs` under the Find phase reads as `logic-bugs`; the phase line already says Find. */
function agentLabel(agent: AgentRowSnapshot, phase: PhaseSnapshot): string {
  const phaseName = phase.title.split(" ▸ ").pop()?.toLowerCase() ?? "";
  const prefix = `${phaseName}:`;
  return phaseName && agent.label.toLowerCase().startsWith(prefix) && agent.label.length > prefix.length
    ? agent.label.slice(prefix.length)
    : agent.label;
}

/** Declared `meta.phases` not reached yet, after the last one the run has entered. */
function upcomingLine(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const planned = snapshot.plannedPhases ?? [];
  const seen = new Set(snapshot.phases.map((phase) => phase.title));
  const lastSeen = planned.reduce((last, title, index) => (seen.has(title) ? index : last), -1);
  const upcoming = planned.slice(lastSeen + 1).filter((title) => !seen.has(title));
  if (upcoming.length === 0) return undefined;
  return `  ${theme.fg("dim", GLYPH.queued)} ${theme.fg("dim", upcoming.join(" · "))}`;
}

/**
 * The latest log when it reports a failure the phase and agent lines do not already count, such as a
 * provider retry or an observer error. Failed agents are reported by their rows and phase totals.
 */
function failureLogLine(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const latest = snapshot.logs.at(-1);
  if (!latest || !FAILURE_LOG.test(latest)) return undefined;
  const failedLabels = snapshot.phases.flatMap((phase) => phase.agents.filter((agent) => agent.status === "failed").map((agent) => agent.label));
  if (failedLabels.some((label) => latest.startsWith(label))) return undefined;
  return `  ${theme.fg("warning", `${GLYPH.warning} ${oneLine(latest)}`)}`;
}

function footerLine(snapshot: WorkflowProgressSnapshot, inspectorHint: string, width: number, theme: Theme): string {
  const hint = keyHints([[inspectorHint, "inspect"]], theme);
  const counters = counterText(snapshot, theme);
  return counters ? spread(`  ${counters}`, hint, width) : spread("", hint, width);
}

/** `3 files · 3 candidates · 2 confirmed`: zeros hidden, verdict labels lower-cased, duplicates dropped. */
function counterText(snapshot: WorkflowProgressSnapshot, theme: Theme): string | undefined {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const counter of snapshot.counters) {
    const label = counter.label.toLowerCase().replaceAll("_", " ");
    if (counter.value === 0 || seen.has(label)) continue;
    seen.add(label);
    parts.push(`${theme.fg("text", formatCount(counter.value))} ${theme.fg(counterColor(counter.key), label)}`);
  }
  return parts.length > 0 ? parts.join(dot(theme)) : undefined;
}

function counterColor(key: string): ThemeColor {
  return key === "kept" ? "success" : "muted";
}

function phaseSpan(agents: readonly AgentRowSnapshot[]): number | undefined {
  const starts = agents.flatMap((agent) => (agent.startedAt === undefined ? [] : [agent.startedAt]));
  const ends = agents.flatMap((agent) => (agent.doneAt === undefined ? [] : [agent.doneAt]));
  if (starts.length === 0 || ends.length === 0) return undefined;
  return Math.max(...ends) - Math.min(...starts);
}

/** `0.6s`, `4.2s`, then `12s` / `1m 4s` for finished spans. */
function shortDuration(ms: number): string {
  if (ms < 10_000) return `${(Math.max(0, ms) / 1_000).toFixed(1)}s`;
  return formatDuration(ms);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
