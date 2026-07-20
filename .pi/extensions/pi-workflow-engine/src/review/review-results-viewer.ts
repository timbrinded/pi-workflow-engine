import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { renderIssueDetailLines } from "./review-format.ts";
import { formatIssueLocation, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { truncateDisplay } from "../ui/workflow-format.ts";
import { fitWorkflowViewerRows, workflowViewerHeight } from "../ui/workflow-viewer-layout.ts";

const SPLIT_WIDTH = 96;
const LIST_MIN_WIDTH = 34;
const LIST_MAX_WIDTH = 48;
const DETAIL_SCROLL_STEP = 5;

type ViewerTui = Pick<TUI, "requestRender" | "terminal">;

export class ReviewResultsViewer implements Component {
  private readonly selected = new Set<string>();
  private cursor = 0;
  private listScroll = 0;
  private detailScroll = 0;
  private detailsExpanded = true;
  private warning: string | undefined;

  constructor(
    private readonly issues: readonly ReviewIssue[],
    private readonly workflowName: string,
    private readonly tui: ViewerTui,
    private readonly theme: Theme,
    private readonly done: (result: ReviewIssueSelection) => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const outerWidth = Math.max(4, width);
    const contentWidth = Math.max(1, outerWidth - 4);
    const innerHeight = Math.max(1, workflowViewerHeight(this.tui.terminal.rows) - 2);
    const body = fitWorkflowViewerRows(this.renderBody(contentWidth, innerHeight), innerHeight);
    return [
      this.theme.fg("borderAccent", `╭${"─".repeat(Math.max(0, outerWidth - 2))}╮`),
      ...body.map((line) => this.borderedRow(line, contentWidth)),
      this.theme.fg("borderAccent", `╰${"─".repeat(Math.max(0, outerWidth - 2))}╯`),
    ];
  }

  handleInput(data: string): void {
    const digitJump = digitJumpIndex(data);
    if (digitJump !== undefined) {
      this.jumpTo(digitJump);
      return;
    }

    if (matchesKey(data, "up")) {
      this.moveCursor(-1);
      return;
    }
    if (matchesKey(data, "down")) {
      this.moveCursor(1);
      return;
    }
    if (matchesKey(data, "space") || data === " ") {
      this.toggleCurrent();
      return;
    }
    if (data === "a") {
      this.toggleAllVisible();
      return;
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r") {
      this.detailsExpanded = !this.detailsExpanded;
      this.detailScroll = 0;
      this.warning = undefined;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "left")) {
      this.scrollDetail(-DETAIL_SCROLL_STEP);
      return;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "right")) {
      this.scrollDetail(DETAIL_SCROLL_STEP);
      return;
    }
    if (data === "f") {
      this.finishSelected("fix");
      return;
    }
    if (data === "c") {
      this.finishSelected("comment");
      return;
    }
    if (data === "q" || matchesKey(data, "escape") || matchesKey(data, "esc")) {
      this.done({ action: "close", issueIds: this.selectedIssueIds() });
    }
  }

  private renderBody(width: number, height: number): string[] {
    const warning = this.warning ? this.theme.fg("warning", this.warning) : "";
    const chromeRows = 5;
    const contentHeight = Math.max(1, height - chromeRows);
    let content: string[];
    if (this.issues.length === 0) {
      content = fitWorkflowViewerRows([this.theme.fg("success", "No findings.")], contentHeight);
    } else if (width >= SPLIT_WIDTH) {
      content = this.renderSplit(width, contentHeight);
    } else {
      content = this.renderStacked(width, contentHeight);
    }

    return [
      this.headerLine(width),
      warning,
      this.theme.fg("borderMuted", "─".repeat(width)),
      ...fitWorkflowViewerRows(content, contentHeight),
      this.theme.fg("borderMuted", "─".repeat(width)),
      this.helpLine(width),
    ];
  }

  private renderSplit(width: number, height: number): string[] {
    const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.floor(width * 0.38)));
    const detailWidth = Math.max(1, width - listWidth - 3);
    const list = this.renderIssuePane(listWidth, height);
    const details = this.renderDetailPane(detailWidth, height);
    const divider = this.theme.fg("borderMuted", "│");
    return Array.from({ length: height }, (_value, index) =>
      `${padAnsi(list[index] ?? "", listWidth)} ${divider} ${padAnsi(details[index] ?? "", detailWidth)}`,
    );
  }

  private renderStacked(width: number, height: number): string[] {
    if (height < 7) return this.renderCompact(width, height);
    const listHeight = Math.max(3, Math.min(height - 4, Math.floor(height * 0.38)));
    const detailHeight = height - listHeight - 1;
    return [
      ...this.renderIssuePane(width, listHeight),
      this.theme.fg("borderMuted", "─".repeat(width)),
      ...this.renderDetailPane(width, detailHeight),
    ];
  }

  private renderCompact(width: number, height: number): string[] {
    if (height <= 0) return [];
    const issue = this.issues[this.cursor];
    const selected = issue ? this.renderIssueRow(issue, this.cursor, width) : this.theme.fg("dim", "No finding selected.");
    if (height === 1) return [selected];
    return [selected, ...this.renderDetailPane(width, height - 1)];
  }

  private renderIssuePane(width: number, height: number): string[] {
    if (height <= 0) return [];
    const itemRows = Math.max(0, height - 2);
    if (itemRows === 0) this.listScroll = 0;
    const maxStart = Math.max(0, this.issues.length - itemRows);
    if (this.cursor < this.listScroll) this.listScroll = this.cursor;
    if (itemRows > 0 && this.cursor >= this.listScroll + itemRows) this.listScroll = this.cursor - itemRows + 1;
    this.listScroll = Math.min(maxStart, Math.max(0, this.listScroll));
    const end = Math.min(this.issues.length, this.listScroll + itemRows);
    const visible = this.issues.slice(this.listScroll, end).map((issue, offset) => this.renderIssueRow(issue, this.listScroll + offset, width));
    const range = this.issues.length === 0 || itemRows === 0 ? `0/${this.issues.length}` : `${this.listScroll + 1}–${end}/${this.issues.length}`;
    const arrows = scrollArrows(this.listScroll > 0, end < this.issues.length);
    const heading = truncateDisplay(
      `${this.theme.fg("accent", this.theme.bold("Findings"))} ${this.theme.fg("muted", `${this.cursor + 1}/${Math.max(1, this.issues.length)}`)}`,
      width,
    );
    const indicator = truncateDisplay(this.theme.fg("dim", `${range}${arrows ? ` ${arrows}` : ""}`), width);
    return [heading, ...fitWorkflowViewerRows(visible, itemRows), indicator].slice(0, height);
  }

  private renderIssueRow(issue: ReviewIssue, index: number, width: number): string {
    const cursor = index === this.cursor ? this.theme.fg("accent", ">") : " ";
    const checked = this.selected.has(issue.id) ? this.theme.fg("success", "x") : " ";
    const severity = this.theme.fg(severityColor(issue.finding.severity), issue.finding.severity);
    const row = `${cursor} [${checked}] ${issue.id} ${severity} ${issue.finding.category} ${formatIssueLocation(issue)} — ${issue.finding.summary}`;
    return truncateDisplay(row, width);
  }

  private renderDetailPane(width: number, height: number): string[] {
    if (height <= 0) return [];
    const issue = this.issues[this.cursor];
    if (!issue) return fitWorkflowViewerRows([this.theme.fg("dim", "No finding selected.")], height);

    const bodyHeight = Math.max(0, height - 2);
    const heading = truncateDisplay(
      `${this.theme.fg("accent", this.theme.bold("Details"))} ${this.theme.fg("muted", issue.id)}`,
      width,
    );
    const lines = this.detailsExpanded
      ? renderIssueDetailLines(issue, this.theme, width)
      : [issue.finding.summary, this.theme.fg("dim", "Press enter to expand details.")];
    if (bodyHeight === 0) this.detailScroll = 0;
    const maxScroll = Math.max(0, lines.length - bodyHeight);
    this.detailScroll = Math.min(maxScroll, Math.max(0, this.detailScroll));
    const end = Math.min(lines.length, this.detailScroll + bodyHeight);
    const visible = lines.slice(this.detailScroll, end).map((line) => truncateDisplay(line, width));
    const range = lines.length === 0 || bodyHeight === 0 ? `0/${lines.length}` : `${this.detailScroll + 1}–${end}/${lines.length}`;
    const arrows = scrollArrows(this.detailScroll > 0, bodyHeight === 0 ? lines.length > 0 : end < lines.length);
    const indicator = truncateDisplay(
      this.theme.fg("dim", `${this.detailsExpanded ? "Lines" : "Collapsed"} ${range}${arrows ? ` ${arrows}` : ""}`),
      width,
    );
    return [heading, ...fitWorkflowViewerRows(visible, bodyHeight), indicator].slice(0, height);
  }

  private headerLine(width: number): string {
    const count = `${this.issues.length} finding${this.issues.length === 1 ? "" : "s"}`;
    const selected = `${this.selected.size} selected`;
    return truncateDisplay(
      `${this.theme.fg("accent", this.theme.bold("Review results"))} ${this.theme.fg("muted", this.workflowName)} ${this.theme.fg("dim", `· ${count} · ${selected}`)}`,
      width,
    );
  }

  private helpLine(width: number): string {
    const help = width >= 110
      ? "↑↓ findings · 1-9 jump · space select · a all · enter details · ←→ scroll · f fix · c comment · q close"
      : "q close · ↑↓ move · space select · enter details · ←→ scroll · f fix · c comment";
    return truncateDisplay(
      this.theme.fg("dim", help),
      width,
    );
  }

  private borderedRow(content: string, width: number): string {
    return `${this.theme.fg("border", "│")} ${padAnsi(content, width)} ${this.theme.fg("border", "│")}`;
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private moveCursor(delta: number): void {
    if (this.issues.length === 0) return;
    this.cursor = Math.min(this.issues.length - 1, Math.max(0, this.cursor + delta));
    this.detailScroll = 0;
    this.warning = undefined;
    this.requestRender();
  }

  private jumpTo(index: number): void {
    if (index < 0 || index >= this.issues.length) {
      this.warning = `No finding ${index + 1}.`;
      this.requestRender();
      return;
    }
    this.cursor = index;
    this.detailScroll = 0;
    this.warning = undefined;
    this.requestRender();
  }

  private toggleCurrent(): void {
    const issue = this.issues[this.cursor];
    if (!issue) return;
    this.toggleIssue(issue.id);
    this.warning = undefined;
    this.requestRender();
  }

  private toggleAllVisible(): void {
    const allSelected = this.issues.length > 0 && this.issues.every((issue) => this.selected.has(issue.id));
    this.selected.clear();
    if (!allSelected) {
      for (const issue of this.issues) this.selected.add(issue.id);
    }
    this.warning = undefined;
    this.requestRender();
  }

  private scrollDetail(delta: number): void {
    this.detailScroll = Math.max(0, this.detailScroll + delta);
    this.warning = undefined;
    this.requestRender();
  }

  private finishSelected(action: "fix" | "comment"): void {
    const issueIds = this.selectedIssueIds();
    if (issueIds.length === 0) {
      this.warning = `Select at least one finding before pressing ${action === "fix" ? "f" : "c"}.`;
      this.requestRender();
      return;
    }
    this.done({ action, issueIds });
  }

  private toggleIssue(id: string): void {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
  }

  private selectedIssueIds(): string[] {
    return this.issues.filter((issue) => this.selected.has(issue.id)).map((issue) => issue.id);
  }
}

function padAnsi(text: string, width: number): string {
  const truncated = truncateDisplay(text, width);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

function scrollArrows(hasAbove: boolean, hasBelow: boolean): string {
  return `${hasAbove ? "↑" : ""}${hasBelow ? "↓" : ""}`;
}

function digitJumpIndex(data: string): number | undefined {
  return data.length === 1 && data >= "1" && data <= "9" ? Number(data) - 1 : undefined;
}

function severityColor(severity: ReviewIssue["finding"]["severity"]): Parameters<Theme["fg"]>[0] {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "muted";
  }
}
