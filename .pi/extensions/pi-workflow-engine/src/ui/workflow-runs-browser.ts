import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { isRecord } from "../guards.ts";
import { formatCount, truncateText } from "../text.ts";
import {
  availableWorkflowRunActions,
  canRelaunchWorkflowRun,
  formatWorkflowRunDuration,
  type WorkflowRunActionContext,
  type WorkflowRunLifecycleAction,
} from "../workflow-run-history.ts";
import type { WorkflowRunRecord, WorkflowRunState } from "../workflow-run-record.ts";
import {
  fit,
  formatCost,
  frame,
  GLYPH,
  hangingWrap,
  joinParts,
  keyHints,
  overlayHeight,
  padStartVisible,
  relativeTime,
  scrollHint,
  type ThemeColor,
} from "./kit.ts";
import { countAgents, formatDuration } from "./workflow-format.ts";

export interface WorkflowRunsBrowserChoice {
  readonly action: WorkflowRunLifecycleAction;
  readonly runId: string;
}

export interface WorkflowRunsListing {
  readonly records: readonly WorkflowRunRecord[];
  readonly runs: WorkflowRunActionContext;
}

export interface WorkflowRunsBrowserOptions {
  /** Run to place the cursor on, e.g. the one just inspected. */
  readonly initialRunId?: string;
  /** Reloads the listing; polled while any run is queued or running so states and times stay live. */
  readonly refresh?: () => Promise<WorkflowRunsListing>;
  readonly refreshMs?: number;
  readonly now?: () => number;
}

type BrowserTui = Pick<TUI, "requestRender" | "terminal">;
type Hint = readonly [key: string, description: string];

const STATE_STYLE: Record<WorkflowRunState, { readonly glyph: string; readonly color: ThemeColor }> = {
  completed: { glyph: GLYPH.done, color: "success" },
  failed: { glyph: GLYPH.failed, color: "error" },
  running: { glyph: GLYPH.running, color: "accent" },
  queued: { glyph: GLYPH.queued, color: "muted" },
  paused: { glyph: GLYPH.warning, color: "warning" },
  stopped: { glyph: "■", color: "muted" },
};

const ACTION_KEYS: Record<WorkflowRunLifecycleAction, Hint> = {
  inspect: ["enter", "inspect"],
  resume: ["r", "resume"],
  stop: ["s", "stop"],
  restart: ["R", "restart"],
};

const SHORT_ID = 8;
const NAME_MAX = 28;
const NAME_MIN = 10;
const LABEL_WIDTH = 10;
const OUTCOME_LINES = 3;
const OUTCOME_CHARS = 600;
const LIST_MIN = 3;
const REFRESH_MS = 1_000;

interface RunCells {
  readonly name: string;
  readonly state: string;
  readonly duration: string;
  readonly age: string;
  readonly cost: string;
  readonly id: string;
}

/**
 * `/workflow:runs` overlay: aligned run rows above a details pane for the cursor run, with the
 * run's lifecycle actions on single keys, gated by the same availability rules as the command.
 */
export class WorkflowRunsBrowser implements Component {
  private records: readonly WorkflowRunRecord[];
  private runs: WorkflowRunActionContext;
  private cursor = 0;
  private scroll = 0;
  private warning: string | undefined;
  private pendingStop: string | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private refreshing = false;
  private readonly now: () => number;

  constructor(
    listing: WorkflowRunsListing,
    private readonly tui: BrowserTui,
    private readonly theme: Theme,
    private readonly done: (choice: WorkflowRunsBrowserChoice | undefined) => void,
    private readonly options: WorkflowRunsBrowserOptions = {},
  ) {
    this.records = listing.records;
    this.runs = listing.runs;
    this.now = options.now ?? Date.now;
    this.cursor = Math.max(0, this.records.findIndex((record) => record.runId === options.initialRunId));
    this.updateRefreshTimer();
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  /** Swaps in a fresh listing, keeping the cursor on the same run. */
  async refresh(): Promise<void> {
    if (!this.options.refresh || this.refreshing) return;
    this.refreshing = true;
    try {
      const cursorRunId = this.records[this.cursor]?.runId;
      const listing = await this.options.refresh();
      this.records = listing.records;
      this.runs = listing.runs;
      const index = this.records.findIndex((record) => record.runId === cursorRunId);
      this.cursor = index >= 0 ? index : Math.min(this.cursor, Math.max(0, this.records.length - 1));
      this.updateRefreshTimer();
      this.tui.requestRender();
    } catch {
      // A failed reload keeps the last listing on screen; the next tick tries again.
    } finally {
      this.refreshing = false;
    }
  }

  private updateRefreshTimer(): void {
    const live = this.records.some((record) => record.state === "queued" || record.state === "running");
    if (live && this.options.refresh && !this.refreshTimer) {
      this.refreshTimer = setInterval(() => void this.refresh(), this.options.refreshMs ?? REFRESH_MS);
      this.refreshTimer.unref?.();
    } else if (!live) {
      this.dispose();
    }
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    const now = this.now();
    const ceiling = Math.max(4, overlayHeight(this.tui.terminal.rows, Number.MAX_SAFE_INTEGER) - 2);
    const detailRows = Math.min(
      Math.max(0, ...this.records.map((record) => this.details(record, inner, now).length)),
      Math.max(1, ceiling - 1 - Math.min(this.records.length, LIST_MIN)),
    );
    const listRows = Math.max(1, Math.min(this.records.length, ceiling - 1 - detailRows));
    const record = this.records[this.cursor];
    const details = record ? this.details(record, inner, now).slice(0, detailRows) : [];
    const body = [
      ...this.renderList(inner, listRows, now),
      this.theme.fg("borderMuted", "─".repeat(inner)),
      ...details,
      ...Array.from({ length: detailRows - details.length }, () => ""),
    ];
    return frame(body, width, this.theme, {
      title: this.theme.fg("accent", this.theme.bold("Workflow runs")),
      right: this.counts(),
      footer: this.footer(inner),
    });
  }

  handleInput(data: string): void {
    const key = decodeKittyPrintable(data) ?? data;
    if (key === "q" || matchesKey(data, "escape")) {
      this.finish(undefined);
      return;
    }
    const stopArmed = this.pendingStop;
    this.pendingStop = undefined;
    this.warning = undefined;
    if (matchesKey(data, "up") || key === "k") this.move(-1);
    else if (matchesKey(data, "down") || key === "j") this.move(1);
    else if (matchesKey(data, "home") || key === "g") this.move(-this.records.length);
    else if (matchesKey(data, "end") || key === "G") this.move(this.records.length);
    else if (matchesKey(data, "enter") || key === "i") this.choose("inspect");
    else if (key === "r") this.choose("resume");
    else if (key === "R") this.choose("restart");
    else if (key === "s") this.chooseStop(stopArmed);
    this.tui.requestRender();
  }

  private renderList(width: number, height: number, now: number): string[] {
    const cells = this.records.map((record) => runCells(record, now));
    const rows = this.records.length > height ? Math.max(1, height - 1) : height;
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + rows) this.scroll = this.cursor - rows + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, this.records.length - rows));
    const layout = columnLayout(cells, width);
    const visible = this.records
      .slice(this.scroll, this.scroll + rows)
      .map((record, offset) => this.renderRow(record, cells[this.scroll + offset], this.scroll + offset, layout));
    if (this.records.length <= height) return visible;
    const hint = scrollHint(this.scroll, this.records.length - this.scroll - visible.length, this.theme) ?? "";
    return [...visible, `    ${hint}`];
  }

  private renderRow(record: WorkflowRunRecord, cells: RunCells | undefined, index: number, layout: ColumnLayout): string {
    if (!cells) return "";
    const style = STATE_STYLE[record.state];
    const selected = index === this.cursor;
    const cursor = selected ? this.theme.fg("accent", GLYPH.cursor) : " ";
    const name = fit(cells.name, layout.name);
    const parts = [
      `${cursor} ${this.theme.fg(style.color, style.glyph)} ${selected ? this.theme.bold(name) : name}`,
      this.theme.fg(style.color, fit(cells.state, layout.state)),
    ];
    if (layout.duration > 0) parts.push(this.theme.fg("muted", padStartVisible(cells.duration, layout.duration)));
    if (layout.age > 0) parts.push(this.theme.fg("muted", padStartVisible(cells.age, layout.age)));
    if (layout.cost > 0) parts.push(this.theme.fg("muted", padStartVisible(cells.cost, layout.cost)));
    if (layout.id > 0) parts.push(this.theme.fg("dim", cells.id));
    return parts.join("  ");
  }

  /** Facts about one run that its row does not already show; each value arrives already styled. */
  private details(record: WorkflowRunRecord, width: number, now: number): string[] {
    const theme = this.theme;
    const muted = (text: string) => theme.fg("muted", text);
    const lines: string[] = [];
    const push = (label: string, value: string | undefined, maxLines = 1) => {
      if (!value) return;
      lines.push(...hangingWrap(value, width, theme.fg("dim", label.padEnd(LABEL_WIDTH, " "))).slice(0, maxLines));
    };

    // Age, duration and cost are in the row; the pane adds wall-clock times and the rest.
    if (record.startedAt === undefined) push("Queued", muted(clockTime(record.createdAt, now)));
    else {
      const ended = record.endedAt ?? (record.state === "paused" ? record.updatedAt : undefined);
      push("Started", joinParts([muted(clockTime(record.startedAt, now)), ended ? muted(`ended ${clockTime(ended, now)}`) : undefined], theme));
    }

    // The tracker's implicit opening phase stays empty unless a workflow never names one.
    const current = record.state === "running" ? record.progress.currentPhase : undefined;
    const phases = record.progress.phases
      .filter((phase) => phase.agents.length > 0 || phase.title === current)
      .map((phase) => (phase.title === current ? theme.fg("accent", phase.title) : muted(phase.title)));
    push("Phases", phases.join(theme.fg("dim", ` ${GLYPH.arrow} `)));

    const counts = countAgents(record.progress.phases);
    if (counts.total > 0) {
      push("Agents", joinParts([
        muted(String(counts.total)),
        counts.running > 0 ? theme.fg("accent", `${counts.running} running`) : undefined,
        counts.failed > 0 ? theme.fg("error", `${counts.failed} failed`) : undefined,
      ], theme));
    }
    const tokens = tokenUsage(record);
    push("Tokens", tokens && muted(tokens));

    const resumedFrom = record.options.resumeFromRunId;
    const resumedAs = this.runs.resumedAs.get(record.runId);
    push("Resumed", joinParts([
      resumedFrom ? muted(`from ${shortId(resumedFrom)}`) : undefined,
      resumedAs ? muted(`superseded by ${shortId(resumedAs)}`) : undefined,
    ], theme));

    if (record.state === "paused" && record.pause) {
      const pause = record.pause;
      push("Paused", joinParts([
        theme.fg("warning", "provider usage limit"),
        muted(`attempt ${pause.attempt}/${pause.maxAttempts}`),
        muted(pause.nextEligibleAt > now ? `eligible in ${formatDuration(pause.nextEligibleAt - now)}` : "eligible now"),
        pause.autoResume ? muted("auto-resume on") : undefined,
      ], theme), 2);
    }

    const outcome = runOutcome(record);
    const outcomeColor: ThemeColor = record.state === "failed" ? "error" : record.state === "completed" ? "text" : "warning";
    push("Outcome", outcome && theme.fg(outcomeColor, outcome), OUTCOME_LINES);

    const blocker = relaunchBlocker(record);
    push(record.state === "paused" ? "Resume" : "Restart", blocker && theme.fg("dim", `unavailable · ${blocker}`));
    return lines;
  }

  private counts(): string {
    const total = `${this.records.length} run${this.records.length === 1 ? "" : "s"}`;
    const byState = (state: WorkflowRunState) => this.records.filter((record) => record.state === state).length;
    const running = byState("running") + byState("queued");
    const failed = byState("failed");
    const paused = byState("paused");
    return joinParts([
      this.theme.fg("muted", total),
      running > 0 ? this.theme.fg("accent", `${running} active`) : undefined,
      paused > 0 ? this.theme.fg("warning", `${paused} paused`) : undefined,
      failed > 0 ? this.theme.fg("error", `${failed} failed`) : undefined,
    ], this.theme);
  }

  private footer(inner: number): string {
    if (this.warning) return this.theme.fg("warning", `${GLYPH.warning} ${this.warning}`);
    const record = this.records[this.cursor];
    const actions = record ? this.actions(record).map((action) => ACTION_KEYS[action]) : [];
    const variants: Hint[][] = [
      [["↑↓", "move"], ...actions, ["q", "close"]],
      [...actions, ["q", "close"]],
      [...actions],
    ];
    const rendered = variants.map((hints) => keyHints(hints, this.theme));
    return rendered.find((hints) => visibleWidth(hints) <= inner - 2) ?? rendered[rendered.length - 1] ?? "";
  }

  private finish(choice: WorkflowRunsBrowserChoice | undefined): void {
    this.dispose();
    this.done(choice);
  }

  private actions(record: WorkflowRunRecord): readonly WorkflowRunLifecycleAction[] {
    return availableWorkflowRunActions(record, this.runs);
  }

  private move(delta: number): void {
    if (this.records.length === 0) return;
    this.cursor = Math.min(this.records.length - 1, Math.max(0, this.cursor + delta));
  }

  private choose(action: WorkflowRunLifecycleAction): void {
    const record = this.records[this.cursor];
    if (!record) return;
    if (!this.actions(record).includes(action)) {
      this.warning = unavailableReason(action, record, this.runs);
      return;
    }
    this.finish({ action, runId: record.runId });
  }

  /** Stop ends live work, so it takes a second press on the same run. */
  private chooseStop(armed: string | undefined): void {
    const record = this.records[this.cursor];
    if (!record) return;
    if (!this.actions(record).includes("stop")) {
      this.warning = unavailableReason("stop", record, this.runs);
      return;
    }
    if (armed === record.runId) {
      this.finish({ action: "stop", runId: record.runId });
      return;
    }
    this.pendingStop = record.runId;
    this.warning = `press s again to stop ${record.workflow.name} ${shortId(record.runId)}`;
  }
}

interface ColumnLayout {
  readonly name: number;
  readonly state: number;
  readonly duration: number;
  readonly age: number;
  readonly cost: number;
  readonly id: number;
}

/** Column widths from the widest cell; when the row is too wide the name shrinks, then cost, age and id drop. */
function columnLayout(cells: readonly RunCells[], width: number): ColumnLayout {
  const widest = (pick: (cell: RunCells) => string) => Math.max(0, ...cells.map((cell) => visibleWidth(pick(cell))));
  let layout: ColumnLayout = {
    name: Math.min(NAME_MAX, widest((cell) => cell.name)),
    state: widest((cell) => cell.state),
    duration: widest((cell) => cell.duration),
    age: widest((cell) => cell.age),
    cost: widest((cell) => cell.cost),
    id: SHORT_ID,
  };
  const total = (candidate: ColumnLayout) =>
    4 + candidate.name + 2 + candidate.state
    + [candidate.duration, candidate.age, candidate.cost, candidate.id].reduce((sum, column) => sum + (column > 0 ? column + 2 : 0), 0);
  const overflow = total(layout) - width;
  if (overflow > 0) layout = { ...layout, name: Math.max(Math.min(NAME_MIN, layout.name), layout.name - overflow) };
  for (const column of ["cost", "age", "id", "duration"] as const) {
    if (total(layout) <= width) break;
    layout = { ...layout, [column]: 0 };
  }
  return layout;
}

function runCells(record: WorkflowRunRecord, now: number): RunCells {
  const cost = record.usage?.totals.cost.total ?? 0;
  return {
    name: record.workflow.name,
    state: record.state,
    duration: record.state === "queued" ? "" : formatWorkflowRunDuration(record, now),
    age: relativeTime(record.createdAt, now),
    cost: cost > 0 ? formatCost(cost) : "",
    id: shortId(record.runId),
  };
}

function shortId(runId: string): string {
  return runId.slice(0, SHORT_ID);
}

/** `↑34k ↓1.2k`; cost is already a row column. */
function tokenUsage(record: WorkflowRunRecord): string | undefined {
  const totals = record.usage?.totals;
  if (!totals || totals.totalTokens <= 0) return undefined;
  return `↑${formatCount(totals.input + totals.cacheRead + totals.cacheWrite)} ↓${formatCount(totals.output)}`;
}

/** `14:02:31` today, `Oct 4 14:02:31` otherwise, in local time. */
function clockTime(at: number, now: number): string {
  const date = new Date(at);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${date.toLocaleString("en", { month: "short" })} ${date.getDate()} ${time}`;
}

const outcomes = new WeakMap<WorkflowRunRecord, string | undefined>();

/**
 * A short outcome line, memoised per record and bounded before wrapping: a stored result can be large,
 * and every run's details are measured on each render to keep the overlay height stable.
 */
function runOutcome(record: WorkflowRunRecord): string | undefined {
  if (!outcomes.has(record)) {
    const outcome = describeOutcome(record);
    outcomes.set(record, outcome === undefined ? undefined : truncateText(outcome, OUTCOME_CHARS));
  }
  return outcomes.get(record);
}

function describeOutcome(record: WorkflowRunRecord): string | undefined {
  if (record.state === "failed" || record.state === "stopped" || record.state === "paused") return record.message;
  if (record.state !== "completed") return undefined;
  if (record.result.kind === "unavailable") return `result unavailable: ${record.result.reason}`;
  const value = record.result.value;
  if (isRecord(value)) {
    const findings = Array.isArray(value.findings) ? `${value.findings.length} finding${value.findings.length === 1 ? "" : "s"}` : undefined;
    const summary = typeof value.summary === "string" ? value.summary : undefined;
    if (findings || summary) return [findings, summary].filter(Boolean).join(" · ");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Why a finished or paused run cannot be relaunched, mirroring `canRelaunchWorkflowRun`. */
function relaunchBlocker(record: WorkflowRunRecord): string | undefined {
  if (record.state === "queued" || record.state === "running" || canRelaunchWorkflowRun(record)) return undefined;
  if (record.workflow.sourceKind !== "file" || typeof record.workflow.sourceFingerprint !== "string") {
    return "the workflow source cannot be verified";
  }
  return record.options.argumentsPresent !== false ? "its arguments were not retained" : undefined;
}

function unavailableReason(action: WorkflowRunLifecycleAction, record: WorkflowRunRecord, runs: WorkflowRunActionContext): string {
  const resumedAs = action === "resume" ? runs.resumedAs.get(record.runId) : undefined;
  if (resumedAs) return `already resumed as ${shortId(resumedAs)}`;
  const relaunch = (action === "resume" && record.state === "paused") || (action === "restart" && record.state !== "paused");
  const blocker = relaunch ? relaunchBlocker(record) : undefined;
  return blocker ? `${action} unavailable · ${blocker}` : `${action} is not available for a ${record.state} run`;
}
