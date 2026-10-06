import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type {
  AgentRowSnapshot,
  PhaseSnapshot,
  WorkflowLaneItemSnapshot,
  WorkflowLaneItemStatus,
  WorkflowProgressSnapshot,
} from "../progress-types.ts";
import { formatCount } from "../text.ts";
import type { WorkflowAgentUsage, WorkflowUsageSnapshot } from "../usage.ts";
import type { WorkflowRunState } from "../workflow-run-record.ts";
import {
  compactUsage,
  fit,
  frame,
  GLYPH,
  hangingWrap,
  joinParts,
  keyHints,
  overlayHeight,
  padStartVisible,
  spread,
  tabBar,
  truncatePath,
  type ThemeColor,
} from "./kit.ts";
import { formatDuration } from "./workflow-format.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./workflow-viewer-layout.ts";

/** What the inspector knows about a run beyond its progress snapshot. */
export interface WorkflowInspectorOutcome {
  /** Optional caption shown above the retained text. */
  readonly label?: string;
  /** Retained result (or failure message); its presence adds the Result tab. */
  readonly text?: string;
  /** Lifecycle state when known. Without it a finished snapshot reads as plain "done". */
  readonly state?: WorkflowRunState;
}

type OutcomeSource = WorkflowInspectorOutcome | (() => WorkflowInspectorOutcome | undefined);

/** The tables need about 80 columns, so narrow terminals give the inspector nearly full width instead of 80%. */
export const WORKFLOW_INSPECTOR_OVERLAY_OPTIONS = {
  overlay: true,
  overlayOptions: { ...WORKFLOW_VIEWER_OVERLAY_OPTIONS.overlayOptions, minWidth: 80 },
} as const;

/** Opens the inspector overlay; resolves when the user closes it. */
export async function showWorkflowInspector(
  ui: Pick<ExtensionContext["ui"], "custom">,
  snapshot: () => WorkflowProgressSnapshot,
  outcome?: OutcomeSource,
): Promise<void> {
  await ui.custom<void>(
    (...[tui, theme, , done]) => new WorkflowInspector(snapshot, tui, theme, () => done(undefined), outcome),
    WORKFLOW_INSPECTOR_OVERLAY_OPTIONS,
  );
}

type TabId = "overview" | "agents" | "findings" | "logs" | "result";

interface Row {
  readonly text: string;
  /** Present on rows the cursor can land on (Agents and Findings). */
  readonly key?: string;
  /** Group headings stay in view above the first selected row of their group. */
  readonly heading?: boolean;
}

interface RunStatus {
  readonly glyph: string;
  readonly color: ThemeColor;
  readonly word: string;
  readonly live: boolean;
}

interface FindingGroup {
  readonly lane: string;
  readonly items: readonly WorkflowLaneItemSnapshot[];
  readonly hidden: number;
}

const TAB_LABELS: Record<TabId, string> = {
  overview: "Overview",
  agents: "Agents",
  findings: "Findings",
  logs: "Logs",
  result: "Result",
};
const LIST_TABS: ReadonlySet<TabId> = new Set(["agents", "findings"]);
const TAB_DIGITS = ["1", "2", "3", "4", "5"] as const;
/** Top border, tab bar, spacer, bottom border. */
const CHROME_ROWS = 4;
const REFRESH_INTERVAL_MS = 1_000;
const MAX_RESULT_SOURCE_LINES = 200;
const MAX_RESULT_RENDERED_LINES = 400;
const MAX_OVERVIEW_FAILURES = 5;
const FUNNEL_KEYS = ["files", "candidates", "verified", "kept"] as const;
const LANE_STATUS_RANK: Record<WorkflowLaneItemStatus, number> = { success: 0, warning: 1, error: 2, running: 3, pending: 4 };
const UUID_PATTERN = /\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Framed, tabbed overlay over one workflow run: live while the run is active, then the completed
 * (or retained) state. Overview, Agents, Findings and Logs read the progress snapshot; Result shows
 * retained outcome text when the caller has it.
 */
export class WorkflowInspector {
  private tabIndex = 0;
  private innerWidth = 76;
  private stableBodyRows = 0;
  private readonly cursorKeys = new Map<TabId, string>();
  private readonly cursorIndexes = new Map<TabId, number>();
  private readonly scrollOffsets = new Map<TabId, number>();
  private readonly expanded = new Set<string>();
  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly snapshotProvider: () => WorkflowProgressSnapshot,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly close: () => void,
    private readonly outcomeSource?: OutcomeSource,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    const tabs = this.tabs(this.outcome());
    const digit = TAB_DIGITS.findIndex((candidate) => matchesKey(data, candidate));
    if (matchesKey(data, "tab") || matchesKey(data, "right")) this.tabIndex = (this.tabIndex + 1) % tabs.length;
    else if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) this.tabIndex = (this.tabIndex + tabs.length - 1) % tabs.length;
    else if (digit >= 0) {
      if (digit >= tabs.length) return;
      this.tabIndex = digit;
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) this.move(-1);
    else if (matchesKey(data, "down") || matchesKey(data, "j")) this.move(1);
    else if (matchesKey(data, "pageUp")) this.move(-this.pageRows());
    else if (matchesKey(data, "pageDown")) this.move(this.pageRows());
    else if (matchesKey(data, "g") || matchesKey(data, "home")) this.move(-Infinity);
    else if (data === "G" || matchesKey(data, "shift+g") || matchesKey(data, "end")) this.move(Infinity);
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) this.toggleExpanded();
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const snapshot = this.snapshotProvider();
    const outcome = this.outcome();
    const status = runStatus(snapshot, outcome?.state);
    this.syncRefresh(status.live);

    const tabs = this.tabs(outcome);
    this.tabIndex = Math.min(this.tabIndex, tabs.length - 1);
    const active = tabs[this.tabIndex] ?? "overview";
    const inner = Math.max(4, width - 4);
    this.innerWidth = inner;

    // The overlay is sized by the structured tabs so switching tabs never changes its height;
    // the free-form Result text scrolls inside that height.
    const structured = (["overview", "agents", "findings", "logs"] as const).map((tab) => this.rows(tab, snapshot, outcome, status, inner));
    this.stableBodyRows = Math.max(this.stableBodyRows, ...structured.map((rows) => rows.length));
    const height = overlayHeight(this.tui.terminal.rows, this.stableBodyRows + CHROME_ROWS);
    const viewRows = Math.max(1, height - CHROME_ROWS);

    const rows = active === "result" ? this.rows(active, snapshot, outcome, status, inner) : structured[tabs.indexOf(active)] ?? [];
    const offset = LIST_TABS.has(active) ? this.scrollToCursor(active, rows, viewRows) : this.clampScroll(active, rows.length, viewRows);
    const visible = rows.slice(offset, offset + viewRows).map((row) => row.text);
    const below = Math.max(0, rows.length - offset - viewRows);

    const counts = this.tabCounts(snapshot);
    const tabLine = tabBar(tabs.map((tab) => ({ label: TAB_LABELS[tab], count: counts[tab] || undefined })), this.tabIndex, this.theme);
    const title = `${this.theme.fg("accent", GLYPH.workflow)} ${this.theme.bold(snapshot.title)}`;
    // Border chrome around the two labels: `╭─ ` + title + ` ` … ` ` + right + ` ─╮`, plus one fill cell.
    const rightRoom = Math.max(0, width - visibleWidth(title) - 9);
    return frame(
      [tabLine, "", ...visible, ...Array.from({ length: viewRows - visible.length }, () => "")],
      width,
      this.theme,
      { title, right: this.headerStatus(snapshot, status, rightRoom), footer: this.footer(active, rows, viewRows, offset, below, width) },
    );
  }

  invalidate(): void {}

  dispose(): void {
    this.syncRefresh(false);
  }

  private outcome(): WorkflowInspectorOutcome | undefined {
    return typeof this.outcomeSource === "function" ? this.outcomeSource() : this.outcomeSource;
  }

  private tabs(outcome: WorkflowInspectorOutcome | undefined): readonly TabId[] {
    const base: TabId[] = ["overview", "agents", "findings", "logs"];
    return outcome?.text !== undefined ? [...base, "result"] : base;
  }

  private activeTab(): TabId {
    return this.tabs(this.outcome())[this.tabIndex] ?? "overview";
  }

  /** Live runs tick (elapsed time, running agents) without waiting for other surfaces to repaint. */
  private syncRefresh(live: boolean): void {
    if (live && this.refreshTimer === undefined) {
      this.refreshTimer = setInterval(() => this.tui.requestRender(), REFRESH_INTERVAL_MS);
      this.refreshTimer.unref?.();
    } else if (!live && this.refreshTimer !== undefined) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private pageRows(): number {
    return Math.max(1, overlayHeight(this.tui.terminal.rows, this.stableBodyRows + CHROME_ROWS) - CHROME_ROWS - 1);
  }

  private currentRows(tab: TabId): Row[] {
    const snapshot = this.snapshotProvider();
    const outcome = this.outcome();
    return this.rows(tab, snapshot, outcome, runStatus(snapshot, outcome?.state), this.innerWidth);
  }

  private move(delta: number): void {
    const tab = this.activeTab();
    if (!LIST_TABS.has(tab)) {
      const current = this.scrollOffsets.get(tab) ?? 0;
      // Clamped against the content on the next render.
      this.scrollOffsets.set(tab, Number.isFinite(delta) ? Math.max(0, current + delta) : delta > 0 ? Number.MAX_SAFE_INTEGER : 0);
      return;
    }
    const keys = selectableKeys(this.currentRows(tab));
    const index = this.cursorIndex(tab, keys);
    const next = Math.min(keys.length - 1, Math.max(0, Number.isFinite(delta) ? index + delta : delta > 0 ? keys.length - 1 : 0));
    const key = keys[next];
    if (key === undefined) return;
    this.cursorKeys.set(tab, key);
    this.cursorIndexes.set(tab, next);
  }

  private toggleExpanded(): void {
    const tab = this.activeTab();
    if (!LIST_TABS.has(tab)) return;
    const keys = selectableKeys(this.currentRows(tab));
    const key = keys[this.cursorIndex(tab, keys)];
    if (!key) return;
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
  }

  /** Resolves the cursor by key so live rows inserted above it do not move the selection. */
  private cursorIndex(tab: TabId, keys: readonly string[]): number {
    const byKey = keys.indexOf(this.cursorKeys.get(tab) ?? "");
    if (byKey >= 0) return byKey;
    return Math.min(Math.max(0, keys.length - 1), this.cursorIndexes.get(tab) ?? 0);
  }

  private selectedKey(tab: TabId, keys: readonly string[]): string | undefined {
    return keys[this.cursorIndex(tab, keys)];
  }

  private scrollToCursor(tab: TabId, rows: readonly Row[], viewRows: number): number {
    const keys = selectableKeys(rows);
    const index = this.cursorIndex(tab, keys);
    const key = keys[index];
    if (key) {
      this.cursorKeys.set(tab, key);
      this.cursorIndexes.set(tab, index);
    }
    const line = key ? rows.findIndex((row) => row.key === key) : 0;
    let end = line;
    while (end + 1 < rows.length && rows[end + 1]?.key === undefined && !rows[end + 1]?.heading && end + 1 - line < viewRows) end++;
    // Keep a heading directly above the cursor in view, and the cursor's expanded details below it.
    const start = line > 0 && rows[line - 1]?.heading ? line - 1 : line;
    let offset = this.scrollOffsets.get(tab) ?? 0;
    if (start < offset) offset = start;
    if (end >= offset + viewRows) offset = Math.min(line, end - viewRows + 1);
    offset = Math.max(0, Math.min(offset, rows.length - viewRows));
    this.scrollOffsets.set(tab, offset);
    return offset;
  }

  private clampScroll(tab: TabId, rowCount: number, viewRows: number): number {
    const offset = Math.max(0, Math.min(this.scrollOffsets.get(tab) ?? 0, rowCount - viewRows));
    this.scrollOffsets.set(tab, offset);
    return offset;
  }

  private tabCounts(snapshot: WorkflowProgressSnapshot): Partial<Record<TabId, number>> {
    return {
      agents: snapshot.phases.reduce((sum, phase) => sum + phase.agents.length, 0),
      findings: findingGroups(snapshot).reduce((sum, group) => sum + group.items.length, 0),
      logs: snapshot.logs.length,
    };
  }

  /** State first; lower-priority parts (run id, then elapsed) drop whole rather than truncating. */
  private headerStatus(snapshot: WorkflowProgressSnapshot, status: RunStatus, room: number): string {
    const th = this.theme;
    const agents = snapshot.phases.flatMap((phase) => phase.agents);
    const failed = agents.filter((agent) => agent.status === "failed").length;
    // A run that finished around failed agents is complete but not clean.
    const degraded = !status.live && failed > 0 && status.color === "success";
    const state = degraded ? th.fg("warning", `${GLYPH.warning} ${status.word}`) : th.fg(status.color, `${status.glyph} ${status.word}`);
    const failures = failed > 0 ? th.fg("error", `${failed} failed`) : undefined;
    const runId = th.fg("dim", `run ${snapshot.runId.slice(0, 8)}`);
    if (status.live) {
      const finished = agents.filter((agent) => agent.status === "done" || agent.status === "failed").length;
      const progress = agents.length > 0 ? `${snapshot.currentPhase} ${finished}/${agents.length}` : snapshot.currentPhase;
      return fitParts([state, th.fg("muted", progress), failures, th.fg("muted", formatDuration(Date.now() - snapshot.startedAt)), runId], room, th);
    }
    const elapsed = snapshot.doneAt !== undefined ? th.fg("muted", formatDuration(snapshot.doneAt - snapshot.startedAt)) : undefined;
    return fitParts([state, failures, elapsed, runId], room, th);
  }

  private footer(tab: TabId, rows: readonly Row[], viewRows: number, offset: number, below: number, width: number): string {
    const clipped = rows.length > viewRows;
    const pairs: (readonly [string, string])[] = [["tab", "sections"]];
    if (LIST_TABS.has(tab) && selectableKeys(rows).length > 0) pairs.push(["↑↓", "move"], ["enter", "expand"]);
    else if (clipped) pairs.push(["↑↓", "scroll"]);
    pairs.push(["q", "close"]);
    const hints = keyHints(pairs, this.theme);
    const scroll = [offset > 0 ? `↑ ${offset} more` : undefined, below > 0 ? `↓ ${below} more` : undefined].filter(Boolean).join("  ");
    if (!scroll) return hints;
    // The frame sets the footer into the bottom border; keep the scroll position at its right end.
    const room = Math.max(0, width - 6);
    const right = this.theme.fg("dim", scroll);
    const left = truncateToWidth(hints, Math.max(0, room - visibleWidth(right) - 3), "…");
    const gap = Math.max(1, room - visibleWidth(left) - visibleWidth(right) - 2);
    return `${left} ${this.theme.fg("borderAccent", "─".repeat(gap))} ${right}`;
  }

  private rows(tab: TabId, snapshot: WorkflowProgressSnapshot, outcome: WorkflowInspectorOutcome | undefined, status: RunStatus, width: number): Row[] {
    switch (tab) {
      case "overview":
        return this.overviewRows(snapshot, status, width);
      case "agents":
        return this.agentRows(snapshot, status, width);
      case "findings":
        return this.findingRows(snapshot, status, width);
      case "logs":
        return this.logRows(snapshot, width);
      case "result":
        return this.resultRows(outcome, width);
    }
  }

  // ── Overview ──────────────────────────────────────────────────────────────────────────────────

  private overviewRows(snapshot: WorkflowProgressSnapshot, status: RunStatus, width: number): Row[] {
    const th = this.theme;
    const phases = visiblePhases(snapshot);
    const rows: Row[] = [];
    if (phases.length === 0) rows.push({ text: th.fg("dim", status.live ? "Starting…" : "No phases recorded.") });
    const titleWidth = Math.min(24, Math.max(8, ...phases.map((phase) => visibleWidth(phase.title))));
    const now = Date.now();
    phases.forEach((phase, index) => {
      const isCurrent = phase.title === snapshot.currentPhase && index === phases.length - 1;
      const { glyph, color } = phaseGlyph(phase, isCurrent && status.live);
      const agents = phase.agents.length;
      const count = agents === 0 ? th.fg("dim", "no agents") : th.fg("muted", `${agents} agent${agents === 1 ? "" : "s"}`);
      const duration = phaseDuration(phase, status.live ? now : undefined);
      const notes = joinParts(
        [
          countNote(phase.agents, "running", "accent", th),
          countNote(phase.agents, "queued", "dim", th),
          countNote(phase.agents, "failed", "error", th),
        ],
        th,
      );
      const line = `${th.fg(color, glyph)} ${fit(phase.title, titleWidth)}  ${fit(count, 10)} ${padStartVisible(th.fg("muted", duration), 6)}  ${notes}`;
      rows.push({ text: line.trimEnd() });
    });

    const stats = this.overviewStats(snapshot);
    if (stats.length > 0) {
      rows.push({ text: "" });
      const labelWidth = Math.max(...stats.map(([label]) => visibleWidth(label))) + 2;
      for (const [label, value] of stats) {
        for (const line of hangingWrap(value, width, fit(th.fg("muted", label), labelWidth))) rows.push({ text: line });
      }
    }

    const failed = snapshot.phases.flatMap((phase) => phase.agents.filter((agent) => agent.status === "failed").map((agent) => ({ agent, phase })));
    if (failed.length > 0) {
      rows.push({ text: "" });
      const labelWidth = Math.min(24, Math.max(...failed.map(({ agent, phase }) => visibleWidth(displayLabel(agent, phase)))));
      for (const { agent, phase } of failed.slice(0, MAX_OVERVIEW_FAILURES)) {
        // One line per failure; the Agents tab expands the full message.
        const message = firstLine(agent.error ?? "error not retained");
        rows.push({ text: `${th.fg("error", `${GLYPH.failed} failed`)}  ${fit(displayLabel(agent, phase), labelWidth)}  ${th.fg("error", message)}` });
      }
      if (failed.length > MAX_OVERVIEW_FAILURES) {
        rows.push({ text: th.fg("dim", `+${failed.length - MAX_OVERVIEW_FAILURES} more failed · see Agents`) });
      }
    }
    return rows;
  }

  private overviewStats(snapshot: WorkflowProgressSnapshot): [string, string][] {
    const th = this.theme;
    const stats: [string, string][] = [];
    const usage = compactUsage(snapshot.usage, th);
    if (usage) stats.push(["Usage", usage]);

    const counters = new Map(snapshot.counters.map((counter) => [counter.key, counter]));
    const funnel = FUNNEL_KEYS.flatMap((key) => {
      const counter = counters.get(key);
      return counter ? [counter] : [];
    });
    const funnelKeys = new Set<string>(funnel.map((counter) => counter.key));
    if (funnelKeys.size > 0) {
      stats.push(["Funnel", funnel.map((counter) => `${formatCount(counter.value)} ${counter.label}`).join(th.fg("dim", ` ${GLYPH.arrow} `))]);
    }
    const verdicts = snapshot.counters.filter((counter) => counter.key.startsWith("verdict.") && counter.value > 0);
    const verdictLabels = new Set(verdicts.map((counter) => plainLabel(counter.label)));
    if (verdicts.length > 0) {
      stats.push(["Verdicts", joinParts(verdicts.map((counter) => `${formatCount(counter.value)} ${plainLabel(counter.label)}`), th)]);
    }
    const others = snapshot.counters.filter(
      (counter) =>
        counter.value > 0 &&
        !funnelKeys.has(counter.key) &&
        !counter.key.startsWith("verdict.") &&
        !verdictLabels.has(plainLabel(counter.label)),
    );
    if (others.length > 0) {
      stats.push(["Counters", joinParts(others.map((counter) => `${formatCount(counter.value)} ${plainLabel(counter.label)}`), th)]);
    }
    for (const [key, value] of snapshot.summary) {
      // Numeric summary entries that mirror a counter would repeat the funnel.
      if (typeof value === "number" && counters.has(key)) continue;
      stats.push([summaryLabel(key), typeof value === "number" ? formatCount(value) : value]);
    }
    return stats;
  }

  // ── Agents ────────────────────────────────────────────────────────────────────────────────────

  private agentRows(snapshot: WorkflowProgressSnapshot, status: RunStatus, width: number): Row[] {
    const th = this.theme;
    const phases = snapshot.phases.filter((phase) => phase.agents.length > 0);
    if (phases.length === 0) return [{ text: th.fg("dim", status.live ? "No agents yet." : "No agents ran.") }];
    const labels = phases.flatMap((phase) => phase.agents.map((agent) => displayLabel(agent, phase)));
    const labelWidth = Math.min(Math.max(12, Math.floor(width * 0.35)), Math.max(8, ...labels.map((label) => visibleWidth(label))));
    const selected = this.selectedKey("agents", phases.flatMap((phase) => phase.agents.map((agent) => agentKey(agent))));
    const now = Date.now();
    const rows: Row[] = [];
    for (const phase of phases) {
      const failed = phase.agents.filter((agent) => agent.status === "failed").length;
      const note = failed > 0 ? ` ${th.fg("error", `${failed} failed`)}` : "";
      rows.push({ text: `  ${th.bold(th.fg("muted", phase.title))}${note}`, heading: true });
      for (const agent of phase.agents) {
        const key = agentKey(agent);
        const cursor = key === selected ? th.fg("accent", GLYPH.cursor) : " ";
        const label = fit(key === selected ? th.bold(displayLabel(agent, phase)) : agentLabelText(agent, phase, th), labelWidth);
        const duration = agent.startedAt === undefined ? "" : shortDuration((agent.doneAt ?? now) - agent.startedAt);
        const tools = agent.toolUses > 0 ? `${agent.toolUses} tool${agent.toolUses === 1 ? "" : "s"}` : "";
        const expanded = this.expanded.has(key);
        // Expanded rows carry the full error and tool below, so the inline note would repeat them.
        const note = expanded ? "" : agentNote(agent, th);
        const line = `${cursor} ${agentGlyph(agent, th)} ${label}  ${padStartVisible(th.fg("muted", duration), 6)}  ${fit(th.fg("dim", tools), 8)}  ${note}`;
        rows.push({ text: line.trimEnd(), key });
        if (expanded) rows.push(...this.agentDetails(agent, phase, snapshot, width));
      }
    }
    return rows;
  }

  private agentDetails(agent: AgentRowSnapshot, phase: PhaseSnapshot, snapshot: WorkflowProgressSnapshot, width: number): Row[] {
    const th = this.theme;
    const fields: [string, string][] = [];
    if (agent.error) fields.push(["error", th.fg("error", agent.error)]);
    if (agent.status === "queued") fields.push(["status", th.fg("muted", "queued, waiting for a free agent slot")]);
    if (agent.lastTool) {
      const calls = agent.toolUses > 1 ? th.fg("dim", ` · last of ${agent.toolUses} tool calls`) : "";
      fields.push(["tool", `${agent.lastTool}${calls}`]);
    }
    const usage = agentUsage(snapshot, agent, phase);
    if (usage.models.length > 0) fields.push(["model", usage.models.join(", ")]);
    const tokens = compactUsage(usage.snapshot, th);
    if (tokens) {
      const shared = usage.entries > 1 ? th.fg("dim", ` · combined for ${usage.entries} agents labelled ${agent.label}`) : "";
      fields.push(["usage", `${tokens}${shared}`]);
    }
    if (fields.length === 0) return [{ text: `      ${th.fg("dim", "No details yet.")}` }];
    const labelWidth = Math.max(...fields.map(([label]) => label.length)) + 2;
    return fields.flatMap(([label, value]) => hangingWrap(value, width, `      ${th.fg("dim", label.padEnd(labelWidth))}`).map((text) => ({ text })));
  }

  // ── Findings ──────────────────────────────────────────────────────────────────────────────────

  private findingRows(snapshot: WorkflowProgressSnapshot, status: RunStatus, width: number): Row[] {
    const th = this.theme;
    const groups = findingGroups(snapshot);
    if (groups.length === 0) return [{ text: th.fg("dim", status.live ? "No findings yet." : "No findings recorded.") }];
    const selected = this.selectedKey("findings", groups.flatMap((group) => group.items.map(findingKey)));
    const locationWidth = Math.max(12, Math.floor(width * 0.35));
    const rows: Row[] = [];
    for (const group of groups) {
      const unverified = !status.live && group.items.every((item) => item.status === "pending");
      const heading = joinParts(
        [
          th.fg("dim", `${group.items.length}`),
          unverified ? th.fg("dim", "not verified") : undefined,
          group.hidden > 0 ? th.fg("dim", `${group.hidden} earlier not shown`) : undefined,
        ],
        th,
      );
      rows.push({ text: `  ${th.bold(th.fg("muted", group.lane))} ${heading}`, heading: true });
      for (const item of group.items) {
        const key = findingKey(item);
        const isSelected = key === selected;
        const cursor = isSelected ? th.fg("accent", GLYPH.cursor) : " ";
        const location = item.subtitle ? ` ${th.fg("muted", truncatePath(item.subtitle.replace(/\s+\([^)]*\)$/, ""), locationWidth))}` : "";
        const title = isSelected ? th.bold(item.title) : item.title;
        const titleRoom = width - 4 - visibleWidth(location) - 1;
        rows.push({ text: `${cursor} ${laneItemGlyph(item.status, status.live, th)} ${spread(title, location, width - 4)}`, key });
        if (this.expanded.has(key)) rows.push(...this.findingDetails(item, width, visibleWidth(item.title) > titleRoom));
      }
    }
    return rows;
  }

  private findingDetails(item: WorkflowLaneItemSnapshot, width: number, titleClipped: boolean): Row[] {
    const th = this.theme;
    const indent = "    ";
    const lines = [
      ...(titleClipped ? hangingWrap(item.title, width, indent) : []),
      ...(item.subtitle ? hangingWrap(th.fg("accent", item.subtitle), width, indent) : []),
      ...(item.details ? hangingWrap(th.fg("muted", item.details), width, indent) : []),
    ];
    return lines.length > 0 ? lines.map((text) => ({ text })) : [{ text: `${indent}${th.fg("dim", "No details recorded.")}` }];
  }

  // ── Logs and result ───────────────────────────────────────────────────────────────────────────

  private logRows(snapshot: WorkflowProgressSnapshot, width: number): Row[] {
    const th = this.theme;
    if (snapshot.logs.length === 0) return [{ text: th.fg("dim", "No log entries.") }];
    return snapshot.logs.flatMap((log) => {
      const message = log.replace(UUID_PATTERN, "$1");
      const tone = logTone(message);
      const prefix = tone === "error" ? th.fg("error", GLYPH.failed) : tone === "warning" ? th.fg("warning", GLYPH.warning) : th.fg("dim", GLYPH.bullet);
      const text = tone === "error" ? th.fg("error", message) : tone === "warning" ? th.fg("warning", message) : message;
      return hangingWrap(text, width, `${prefix} `).map((line) => ({ text: line }));
    });
  }

  private resultRows(outcome: WorkflowInspectorOutcome | undefined, width: number): Row[] {
    const th = this.theme;
    if (outcome?.text === undefined) return [{ text: th.fg("dim", "No retained result for this run.") }];
    const rows: Row[] = outcome.label ? [{ text: th.fg("dim", outcome.label) }] : [];
    const source = outcome.text.split("\n");
    for (const sourceLine of source.slice(0, MAX_RESULT_SOURCE_LINES)) {
      // Continuations keep the source indentation so wrapped JSON still reads as nested.
      const indent = /^\s*/.exec(sourceLine)?.[0] ?? "";
      for (const line of hangingWrap(sourceLine.slice(indent.length), width - 2, indent, `${indent}  `)) {
        if (rows.length >= MAX_RESULT_RENDERED_LINES) break;
        rows.push({ text: line });
      }
    }
    if (source.length > MAX_RESULT_SOURCE_LINES || rows.length >= MAX_RESULT_RENDERED_LINES) {
      rows.push({ text: th.fg("dim", "… retained result truncated for display") });
    }
    return rows;
  }
}

/** Joins parts with the kit separator, keeping the longest prefix that fits `room` (the first part always). */
function fitParts(parts: readonly (string | undefined)[], room: number, theme: Theme): string {
  const present = parts.filter((part): part is string => part !== undefined);
  for (let count = present.length; count > 1; count--) {
    const joined = joinParts(present.slice(0, count), theme);
    if (visibleWidth(joined) <= room) return joined;
  }
  return present[0] ?? "";
}

function runStatus(snapshot: WorkflowProgressSnapshot, state: WorkflowRunState | undefined): RunStatus {
  switch (state ?? (snapshot.doneAt === undefined ? "running" : undefined)) {
    case "queued":
      return { glyph: GLYPH.queued, color: "dim", word: "queued", live: true };
    case "running":
      return { glyph: GLYPH.running, color: "accent", word: "running", live: snapshot.doneAt === undefined };
    case "completed":
      return { glyph: GLYPH.done, color: "success", word: "completed", live: false };
    case "failed":
      return { glyph: GLYPH.failed, color: "error", word: "failed", live: false };
    case "stopped":
      return { glyph: GLYPH.warning, color: "warning", word: "stopped", live: false };
    case "paused":
      return { glyph: GLYPH.warning, color: "warning", word: "paused", live: false };
    case undefined:
      return { glyph: GLYPH.done, color: "success", word: "done", live: false };
  }
}

/** Phases in chronological order, without the tracker's implicit empty "Workflow" phase. */
function visiblePhases(snapshot: WorkflowProgressSnapshot): readonly PhaseSnapshot[] {
  const [first, ...rest] = snapshot.phases;
  if (first && first.agents.length === 0 && rest.length > 0) return rest;
  return snapshot.phases;
}

function phaseGlyph(phase: PhaseSnapshot, activeAndLive: boolean): { glyph: string; color: ThemeColor } {
  const agents = phase.agents;
  if (agents.some((agent) => agent.status === "running") || (activeAndLive && agents.length === 0)) return { glyph: GLYPH.running, color: "accent" };
  if (agents.length > 0 && agents.every((agent) => agent.status === "queued")) return { glyph: GLYPH.queued, color: "dim" };
  if (agents.some((agent) => agent.status === "queued")) return { glyph: GLYPH.running, color: "accent" };
  if (agents.length > 0 && agents.every((agent) => agent.status === "failed")) return { glyph: GLYPH.failed, color: "error" };
  return { glyph: GLYPH.done, color: "success" };
}

function phaseDuration(phase: PhaseSnapshot, now: number | undefined): string {
  const started = phase.agents.flatMap((agent) => (agent.startedAt === undefined ? [] : [agent.startedAt]));
  if (started.length === 0) return "";
  const ended = phase.agents.flatMap((agent) => {
    if (agent.doneAt !== undefined) return [agent.doneAt];
    return agent.status === "running" && now !== undefined ? [now] : [];
  });
  if (ended.length === 0) return "";
  return shortDuration(Math.max(...ended) - Math.min(...started));
}

function countNote(agents: readonly AgentRowSnapshot[], status: AgentRowSnapshot["status"], color: ThemeColor, theme: Theme): string | undefined {
  const count = agents.filter((agent) => agent.status === status).length;
  return count > 0 ? theme.fg(color, `${count} ${status}`) : undefined;
}

/** `0.6s` / `12s` / `1m 4s`: one decimal below ten seconds so short agents stay distinguishable. */
function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  return formatDuration(ms);
}

/** `find:logic-bugs` under the Find phase reads as `logic-bugs`. */
function displayLabel(agent: AgentRowSnapshot, phase: PhaseSnapshot): string {
  const prefix = `${phase.title.toLowerCase()}:`;
  return agent.label.toLowerCase().startsWith(prefix) && agent.label.length > prefix.length ? agent.label.slice(prefix.length) : agent.label;
}

function agentLabelText(agent: AgentRowSnapshot, phase: PhaseSnapshot, theme: Theme): string {
  const label = displayLabel(agent, phase);
  return agent.status === "running" ? label : theme.fg(agent.status === "queued" ? "dim" : "muted", label);
}

function agentGlyph(agent: AgentRowSnapshot, theme: Theme): string {
  switch (agent.status) {
    case "done":
      return theme.fg("success", GLYPH.done);
    case "failed":
      return theme.fg("error", GLYPH.failed);
    case "running":
      return theme.fg("accent", GLYPH.running);
    case "queued":
      return theme.fg("dim", GLYPH.queued);
  }
}

function agentNote(agent: AgentRowSnapshot, theme: Theme): string {
  if (agent.status === "failed") return theme.fg("error", firstLine(agent.error ?? "failed"));
  if (agent.status === "queued") return theme.fg("dim", "queued");
  if (agent.status === "running" && agent.lastTool) return theme.fg("dim", agent.lastTool);
  return "";
}

/**
 * Usage recorded for an agent. Labels are display text rather than unique ids, so agents sharing a
 * label (two `verify:cache.ts` runs) report their combined usage instead of a guessed pairing.
 */
function agentUsage(
  snapshot: WorkflowProgressSnapshot,
  agent: AgentRowSnapshot,
  phase: PhaseSnapshot,
): { models: string[]; entries: number; snapshot: WorkflowUsageSnapshot | undefined } {
  const matches = (snapshot.usage?.agents ?? []).filter(
    (entry) => entry.label === agent.label && (entry.phase === undefined || entry.phase === phase.title),
  );
  const models = [...new Set(matches.flatMap((entry) => (entry.model ? [entry.provider ? `${entry.provider}/${entry.model}` : entry.model] : [])))];
  return { models, entries: matches.length, snapshot: combinedUsage(matches) };
}

function combinedUsage(entries: readonly WorkflowAgentUsage[]): WorkflowUsageSnapshot | undefined {
  const [first] = entries;
  if (!first) return undefined;
  const sum = (pick: (entry: WorkflowAgentUsage) => number) => entries.reduce((total, entry) => total + pick(entry), 0);
  return {
    agents: entries,
    assistantMessages: sum((entry) => entry.assistantMessages),
    totals: {
      ...first.usage,
      input: sum((entry) => entry.usage.input),
      output: sum((entry) => entry.usage.output),
      cacheRead: sum((entry) => entry.usage.cacheRead),
      cacheWrite: sum((entry) => entry.usage.cacheWrite),
      totalTokens: sum((entry) => entry.usage.totalTokens),
      cost: { ...first.usage.cost, total: sum((entry) => entry.usage.cost.total) },
    },
  };
}

/**
 * Lane items grouped for display. An item re-emitted into a later lane (a candidate that was
 * verified) is shown only in its latest lane, so resolved candidates never linger as pending.
 * Lanes are ordered by their best item status: confirmed work first, unverified last.
 */
function findingGroups(snapshot: WorkflowProgressSnapshot): FindingGroup[] {
  const latest = new Map<string, WorkflowLaneItemSnapshot>();
  for (const [, items] of snapshot.lanes) {
    for (const item of items) {
      const key = findingKey(item);
      const previous = latest.get(key);
      if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
    }
  }
  const hidden = new Map(snapshot.laneOverflow);
  const groups = snapshot.lanes.flatMap(([lane, items]) => {
    const current = items.filter((item) => latest.get(findingKey(item)) === item);
    return current.length > 0 ? [{ lane, items: current, hidden: hidden.get(lane) ?? 0 }] : [];
  });
  const rank = (group: FindingGroup) => Math.min(...group.items.map((item) => LANE_STATUS_RANK[item.status]));
  return groups.map((group, index) => ({ group, index })).sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index).map(({ group }) => group);
}

function agentKey(agent: AgentRowSnapshot): string {
  return `agent:${agent.id}`;
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0] ?? text;
}

function findingKey(item: WorkflowLaneItemSnapshot): string {
  return `finding:${item.title}\u0000${item.subtitle ?? ""}`;
}

function laneItemGlyph(status: WorkflowLaneItemStatus, live: boolean, theme: Theme): string {
  switch (status) {
    case "success":
      return theme.fg("success", GLYPH.done);
    case "warning":
      return theme.fg("warning", GLYPH.warning);
    case "error":
      return theme.fg("error", GLYPH.failed);
    case "running":
      return theme.fg("accent", GLYPH.running);
    case "pending":
      // A finished run will never verify it; an open circle would read as still waiting.
      return theme.fg("dim", live ? GLYPH.queued : "–");
  }
}

function selectableKeys(rows: readonly Row[]): string[] {
  return rows.flatMap((row) => (row.key === undefined ? [] : [row.key]));
}

function logTone(message: string): "error" | "warning" | "info" {
  if (/\b(fail(ed|ure|s)?|errors?|exception|crash(ed)?|abort(ed)?)\b/i.test(message)) return "error";
  if (/\b(warn(ing)?|dropped|skipp(ed|ing)|retry(ing)?|retried|incomplete|time(d)? ?out|paused|stopped)\b/i.test(message)) return "warning";
  return "info";
}

/** `NOT_SUBSTANTIATED` → `not substantiated`; already-plain labels pass through lower-cased. */
function plainLabel(label: string): string {
  return label.replace(/_/g, " ").toLowerCase();
}

/** `diffCommand` → `Diff command`, `research.question` → `Question`. */
function summaryLabel(key: string): string {
  const last = key.split(".").pop() || key;
  const words = last.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
