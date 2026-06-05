import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { renderIssueDetailLines } from "./review-format.ts";
import { formatIssueLocation, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { truncateDisplay } from "../ui/workflow-format.ts";

const MIN_WIDTH = 40;
const SPLIT_WIDTH = 96;
const LIST_MIN_WIDTH = 34;
const LIST_MAX_WIDTH = 48;
const DETAIL_SCROLL_STEP = 5;

export class ReviewResultsViewer implements Component {
  private readonly selected = new Set<string>();
  private cursor = 0;
  private detailScroll = 0;
  private detailsExpanded = true;
  private warning: string | undefined;

  constructor(
    private readonly issues: readonly ReviewIssue[],
    private readonly workflowName: string,
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (result: ReviewIssueSelection) => void,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const outerWidth = Math.max(MIN_WIDTH, width);
    const innerWidth = Math.max(1, outerWidth - 2);
    const body = this.renderBody(innerWidth);
    return [this.topBorder(innerWidth), ...body.map((line) => `│${padAnsi(line, innerWidth)}│`), this.bottomBorder(innerWidth)];
  }

  handleInput(data: string): void {
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

  private renderBody(width: number): string[] {
    const header = this.headerLine(width);
    const help = this.helpLine(width);
    const warning = this.warning ? [this.theme.fg("warning", this.warning)] : [];
    if (this.issues.length === 0) return [header, this.theme.fg("success", "No findings."), ...warning, help];

    const split = width >= SPLIT_WIDTH;
    const content = split ? this.renderSplit(width) : this.renderStacked(width);
    return [header, ...warning, ...content, help];
  }

  private renderSplit(width: number): string[] {
    const listWidth = Math.min(LIST_MAX_WIDTH, Math.max(LIST_MIN_WIDTH, Math.floor(width * 0.42)));
    const detailWidth = Math.max(20, width - listWidth - 3);
    const list = this.renderIssueList(listWidth);
    const details = this.renderDetail(detailWidth);
    const rows = Math.max(list.length, details.length);
    const lines: string[] = [];
    for (let index = 0; index < rows; index++) {
      lines.push(`${padAnsi(list[index] ?? "", listWidth)} ${this.theme.fg("dim", "│")} ${padAnsi(details[index] ?? "", detailWidth)}`);
    }
    return lines;
  }

  private renderStacked(width: number): string[] {
    return [...this.renderIssueList(width), this.theme.fg("dim", "─".repeat(Math.max(1, width))), ...this.renderDetail(width)];
  }

  private renderIssueList(width: number): string[] {
    return this.issues.map((issue, index) => {
      const cursor = index === this.cursor ? this.theme.fg("accent", ">") : " ";
      const checked = this.selected.has(issue.id) ? this.theme.fg("success", "x") : " ";
      const severity = this.theme.fg(severityColor(issue.finding.severity), issue.finding.severity);
      const row = `${cursor} [${checked}] ${issue.id} ${severity} ${issue.finding.category} ${formatIssueLocation(issue)} — ${issue.finding.summary}`;
      return truncateDisplay(row, width);
    });
  }

  private renderDetail(width: number): string[] {
    const issue = this.issues[this.cursor];
    if (!issue) return [this.theme.fg("dim", "No finding selected.")];
    if (!this.detailsExpanded) return [this.theme.fg("accent", issue.id), issue.finding.summary, this.theme.fg("dim", "Press enter to expand details.")];
    const lines = renderIssueDetailLines(issue, this.theme, width);
    const maxScroll = Math.max(0, lines.length - 1);
    this.detailScroll = Math.min(this.detailScroll, maxScroll);
    const visible = lines.slice(this.detailScroll, this.detailScroll + 14);
    if (this.detailScroll > 0) visible.unshift(this.theme.fg("dim", "↑ more"));
    if (this.detailScroll + 14 < lines.length) visible.push(this.theme.fg("dim", "↓ more"));
    return visible.map((line) => truncateDisplay(line, width));
  }

  private headerLine(width: number): string {
    const count = `${this.issues.length} finding${this.issues.length === 1 ? "" : "s"}`;
    const selected = `${this.selected.size} selected`;
    return truncateDisplay(`${this.theme.fg("accent", this.theme.bold("Review results"))} ${this.theme.fg("muted", this.workflowName)} · ${count} · ${selected}`, width);
  }

  private helpLine(width: number): string {
    return truncateDisplay(this.theme.fg("dim", "↑/↓ move · space tag · a all · enter expand · ←/→ scroll · f fix · c comment · q close"), width);
  }

  private topBorder(innerWidth: number): string {
    return `┌${this.theme.fg("dim", "─".repeat(innerWidth))}┐`;
  }

  private bottomBorder(innerWidth: number): string {
    return `└${this.theme.fg("dim", "─".repeat(innerWidth))}┘`;
  }

  private moveCursor(delta: number): void {
    if (this.issues.length === 0) return;
    this.cursor = Math.min(this.issues.length - 1, Math.max(0, this.cursor + delta));
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
