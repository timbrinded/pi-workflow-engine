import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { formatWorkflowUsageLine } from "../usage.ts";
import {
  availableWorkflowRunActions,
  formatWorkflowRunDuration,
  type WorkflowRunLifecycleAction,
  workflowRunStateLabel,
} from "../workflow-run-history.ts";
import type { WorkflowRunRecord, WorkflowRunState } from "../workflow-run-record.ts";
import { formatDuration, truncateDisplay, type WorkflowThemeColor } from "./workflow-format.ts";

export interface WorkflowRunNavigatorSelection {
  readonly action: WorkflowRunLifecycleAction;
  readonly runId: string;
}

export class WorkflowRunNavigator {
  private selected = 0;

  constructor(
    private readonly records: readonly WorkflowRunRecord[],
    private readonly activeRunIds: ReadonlySet<string>,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly close: (selection: WorkflowRunNavigatorSelection | undefined) => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.close(undefined);
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(Math.max(0, this.records.length - 1), this.selected + 1);
      this.tui.requestRender();
      return;
    }

    const record = this.records[this.selected];
    if (!record) return;
    const actions = availableWorkflowRunActions(record, this.activeRunIds.has(record.runId));
    if (matchesKey(data, "return") || matchesKey(data, "enter") || data === "i") {
      this.close({ action: "inspect", runId: record.runId });
      return;
    }
    if (data === "s" && actions.includes("stop")) {
      this.close({ action: "stop", runId: record.runId });
      return;
    }
    if (data === "r") {
      if (actions.includes("resume")) this.close({ action: "resume", runId: record.runId });
      else if (actions.includes("restart")) this.close({ action: "restart", runId: record.runId });
    }
  }

  render(width: number): string[] {
    return renderWorkflowRunNavigatorLines(
      this.records,
      this.activeRunIds,
      this.selected,
      width,
      Math.max(5, Math.floor(this.tui.terminal.rows * 0.8)),
      this.theme,
    );
  }

  invalidate(): void {}
}

export function renderWorkflowRunNavigatorLines(
  records: readonly WorkflowRunRecord[],
  activeRunIds: ReadonlySet<string>,
  selected: number,
  width: number,
  maxHeight: number,
  theme: Theme,
  now = Date.now(),
): string[] {
  const safeWidth = Math.max(30, width);
  const inner = safeWidth - 4;
  const bodyHeight = Math.max(1, maxHeight - 6);
  const selectedIndex = Math.min(Math.max(0, records.length - 1), Math.max(0, selected));
  const maxStart = Math.max(0, records.length - bodyHeight);
  const start = Math.min(maxStart, Math.max(0, selectedIndex - Math.floor(bodyHeight / 2)));
  const visible = records.slice(start, start + bodyHeight);
  const lines = [
    theme.fg("border", `╭${"─".repeat(safeWidth - 2)}╮`),
    row(` ${theme.fg("accent", theme.bold("Workflow Runs"))} ${theme.fg("dim", `· ${records.length} recent`)}`, inner, theme),
    row(theme.fg("dim", "─".repeat(inner)), inner, theme),
  ];

  if (records.length === 0) {
    lines.push(row(theme.fg("dim", "No durable workflow runs are available for this project."), inner, theme));
  } else {
    visible.forEach((record, index) => {
      const absoluteIndex = start + index;
      lines.push(row(runLine(record, absoluteIndex === selectedIndex, inner, theme, now), inner, theme));
    });
  }
  const renderedBody = records.length === 0 ? 1 : visible.length;
  for (let index = renderedBody; index < bodyHeight; index++) lines.push(row("", inner, theme));

  lines.push(row(theme.fg("dim", "─".repeat(inner)), inner, theme));
  const selectedRecord = records[selectedIndex];
  const actions = selectedRecord
    ? availableWorkflowRunActions(selectedRecord, activeRunIds.has(selectedRecord.runId))
    : [];
  const controls = ["↑↓ select", "enter inspect"];
  if (actions.includes("stop")) controls.push("s stop");
  if (actions.includes("resume")) controls.push("r resume");
  if (actions.includes("restart")) controls.push("r restart");
  controls.push("q/esc close");
  lines.push(row(theme.fg("dim", controls.join(" · ")), inner, theme));
  lines.push(theme.fg("border", `╰${"─".repeat(safeWidth - 2)}╯`));
  return lines.map((line) => truncateDisplay(line, safeWidth));
}

function runLine(
  record: WorkflowRunRecord,
  selected: boolean,
  width: number,
  theme: Theme,
  now: number,
): string {
  const usage = formatWorkflowUsageLine(record.usage);
  const parts = [
    `${runStateIcon(record.state, theme)} ${theme.fg(runStateColor(record.state), workflowRunStateLabel(record.state))}`,
    theme.bold(record.workflow.name),
    `age ${formatDuration(Math.max(0, now - record.createdAt))}`,
    `duration ${formatWorkflowRunDuration(record, now)}`,
  ];
  if (usage) parts.push(usage);
  parts.push(record.runId);
  const line = truncateDisplay(parts.join(theme.fg("dim", " · ")), width);
  return selected ? theme.bg("selectedBg", padRight(line, width)) : line;
}

function runStateIcon(state: WorkflowRunState, theme: Theme): string {
  switch (state) {
    case "queued":
      return theme.fg("dim", "○");
    case "running":
      return theme.fg("accent", "●");
    case "paused":
      return theme.fg("warning", "Ⅱ");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "stopped":
      return theme.fg("muted", "■");
  }
}

function runStateColor(state: WorkflowRunState): WorkflowThemeColor {
  switch (state) {
    case "running":
      return "accent";
    case "paused":
      return "warning";
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "queued":
      return "dim";
    case "stopped":
      return "muted";
  }
}

function row(content: string, width: number, theme: Theme): string {
  const truncated = truncateDisplay(content, width);
  return `${theme.fg("border", "│")} ${padRight(truncated, width)} ${theme.fg("border", "│")}`;
}

function padRight(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
