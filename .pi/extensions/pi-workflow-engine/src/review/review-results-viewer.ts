import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { renderFindingDetail, renderFindingRow, sortIssuesForDisplay } from "./review-format.ts";
import { dot, fit, frame, GLYPH, keyHints, overlayHeight, scrollHint } from "../ui/kit.ts";
import { isCommentableIssue, type ReviewIssue, type ReviewIssueSelection } from "./review-issues.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "../ui/workflow-viewer-layout.ts";

/** Inner width from which the list and the detail pane sit side by side. */
const SPLIT_WIDTH = 96;
const SPLIT_LIST_SHARE = 0.5;
const SPLIT_LIST_MIN = 40;
const SPLIT_LIST_MAX = 64;
/** Stacked layout keeps at least this many detail rows below the list. */
const STACKED_DETAIL_MIN = 6;
const PREFIX_WIDTH = 4;

type ViewerTui = Pick<TUI, "requestRender" | "terminal">;
type Hint = readonly [key: string, description: string];

export interface ReviewResultsViewerContext {
  readonly ui: Pick<ExtensionContext["ui"], "custom">;
}

export async function showReviewResultsViewer(
  ctx: ReviewResultsViewerContext,
  issues: readonly ReviewIssue[],
): Promise<ReviewIssueSelection> {
  return await ctx.ui.custom<ReviewIssueSelection>(
    (tui, theme, _keybindings, done) => new ReviewResultsViewer(issues, tui, theme, done),
    WORKFLOW_VIEWER_OVERLAY_OPTIONS,
  );
}

/**
 * Framed findings triage overlay: most severe first, a selectable list with the cursor finding's full
 * detail beside it (or below it when narrow), and selection-gated patch-preview and PR-comment actions.
 */
export class ReviewResultsViewer implements Component {
  private readonly issues: readonly ReviewIssue[];
  private readonly reportOrder: readonly ReviewIssue[];
  private readonly selected = new Set<string>();
  private cursor = 0;
  private listScroll = 0;
  private detailScroll = 0;
  private detailClipped = false;
  private warning: string | undefined;
  private detailHeightCache: { readonly width: number; readonly rows: number } | undefined;

  constructor(
    issues: readonly ReviewIssue[],
    private readonly tui: ViewerTui,
    private readonly theme: Theme,
    private readonly done: (result: ReviewIssueSelection) => void,
  ) {
    this.reportOrder = issues;
    this.issues = sortIssuesForDisplay(issues);
  }

  invalidate(): void {
    this.detailHeightCache = undefined;
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.detailClipped = false;
    const body = this.issues.length === 0
      ? [this.theme.fg("muted", "No findings.")]
      : inner >= SPLIT_WIDTH ? this.renderSplit(inner) : this.renderStacked(inner);
    return frame(body, width, this.theme, {
      title: `${this.theme.fg("accent", this.theme.bold("Review findings"))}${dot(this.theme)}${this.theme.fg("muted", "code-review")}`,
      right: this.counts(),
      footer: this.footer(inner),
    });
  }

  handleInput(data: string): void {
    const key = decodeKittyPrintable(data) ?? data;
    if (key === "q" || matchesKey(data, "escape")) {
      this.done({ action: "close", issueIds: this.selectedIssueIds() });
      return;
    }
    this.warning = undefined;
    if (matchesKey(data, "up") || key === "k") this.moveCursor(-1);
    else if (matchesKey(data, "down") || key === "j") this.moveCursor(1);
    else if (matchesKey(data, "home") || key === "g") this.moveCursor(-this.issues.length);
    else if (matchesKey(data, "end") || key === "G") this.moveCursor(this.issues.length);
    else if (matchesKey(data, "pageUp")) this.detailScroll = Math.max(0, this.detailScroll - this.pageSize());
    else if (matchesKey(data, "pageDown")) this.detailScroll += this.pageSize();
    else if (matchesKey(data, "space") || matchesKey(data, "enter")) this.toggleCurrent();
    else if (key === "a") this.toggleAll();
    else if (key === "f") this.finish("fix");
    else if (key === "c") this.finish("comment");
    this.tui.requestRender();
  }

  private renderSplit(inner: number): string[] {
    const listWidth = Math.min(SPLIT_LIST_MAX, Math.max(SPLIT_LIST_MIN, Math.floor(inner * SPLIT_LIST_SHARE)));
    const detailWidth = Math.max(1, inner - listWidth - 3);
    const height = Math.min(this.bodyCeiling(), Math.max(this.issues.length, this.detailHeight(detailWidth)));
    const list = this.renderList(listWidth, height);
    const detail = this.renderDetail(detailWidth, height);
    const divider = this.theme.fg("borderMuted", "│");
    const rows: string[] = [];
    for (let index = 0; index < height; index++) rows.push(`${fit(list[index] ?? "", listWidth)} ${divider} ${detail[index] ?? ""}`);
    return rows;
  }

  private renderStacked(inner: number): string[] {
    const ceiling = this.bodyCeiling();
    const detailNeed = this.detailHeight(inner);
    const listRows = Math.max(1, Math.min(this.issues.length, ceiling - 1 - Math.min(detailNeed, STACKED_DETAIL_MIN)));
    const detailRows = Math.max(1, Math.min(detailNeed, ceiling - listRows - 1));
    const detail = this.renderDetail(inner, detailRows);
    return [
      ...this.renderList(inner, listRows),
      this.theme.fg("borderMuted", "─".repeat(inner)),
      ...detail,
      ...new Array<string>(Math.max(0, detailRows - detail.length)).fill(""),
    ];
  }

  /** Finding rows with cursor and selection marks; a scroll hint takes the last row only when clipped. */
  private renderList(width: number, height: number): string[] {
    const rows = this.issues.length > height ? Math.max(1, height - 1) : height;
    if (this.cursor < this.listScroll) this.listScroll = this.cursor;
    if (this.cursor >= this.listScroll + rows) this.listScroll = this.cursor - rows + 1;
    this.listScroll = Math.max(0, Math.min(this.listScroll, this.issues.length - rows));
    const visible = this.issues.slice(this.listScroll, this.listScroll + rows).map((issue, offset) => this.renderRow(issue, this.listScroll + offset, width));
    const hint = scrollHint(this.listScroll, this.issues.length - this.listScroll - visible.length, this.theme);
    return hint && this.issues.length > height ? [...visible, `${" ".repeat(PREFIX_WIDTH)}${hint}`] : visible;
  }

  private renderRow(issue: ReviewIssue, index: number, width: number): string {
    const cursor = index === this.cursor ? this.theme.fg("accent", GLYPH.cursor) : " ";
    const mark = this.selected.has(issue.id) ? this.theme.fg("success", GLYPH.running) : this.theme.fg("dim", GLYPH.queued);
    return `${cursor} ${mark} ${renderFindingRow(issue, Math.max(1, width - PREFIX_WIDTH), this.theme)}`;
  }

  private renderDetail(width: number, height: number): string[] {
    const issue = this.issues[this.cursor];
    if (!issue) return [];
    const lines = renderFindingDetail(issue, width, this.theme);
    if (lines.length <= height) {
      this.detailScroll = 0;
      return lines;
    }
    this.detailClipped = true;
    const rows = Math.max(1, height - 1);
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, lines.length - rows));
    const below = lines.length - this.detailScroll - rows;
    const hint = scrollHint(this.detailScroll, below, this.theme) ?? "";
    return [...lines.slice(this.detailScroll, this.detailScroll + rows), hint];
  }

  /** The tallest finding detail at this width, so the overlay keeps one height while the cursor moves. */
  private detailHeight(width: number): number {
    if (this.detailHeightCache?.width !== width) {
      const rows = Math.max(0, ...this.issues.map((issue) => renderFindingDetail(issue, width, this.theme).length));
      this.detailHeightCache = { width, rows };
    }
    return this.detailHeightCache.rows;
  }

  private bodyCeiling(): number {
    return Math.max(3, overlayHeight(this.tui.terminal.rows, Number.MAX_SAFE_INTEGER) - 2);
  }

  private pageSize(): number {
    return Math.max(1, Math.floor(this.bodyCeiling() / 2));
  }

  private counts(): string {
    const findings = `${this.issues.length} finding${this.issues.length === 1 ? "" : "s"}`;
    const selected = this.selected.size > 0 ? this.theme.fg("success", `${this.selected.size} selected`) : undefined;
    return [this.theme.fg("muted", findings), selected].filter(Boolean).join(dot(this.theme));
  }

  /** Key hints in the bottom border; a transient warning replaces them until the next key. */
  private footer(inner: number): string {
    if (this.warning) return this.theme.fg("warning", `${GLYPH.warning} ${this.warning}`);
    const scroll: Hint[] = this.detailClipped ? [["pgup/pgdn", "scroll"]] : [];
    const variants: Hint[][] = [
      [["↑↓", "move"], ["space", "select"], ["a", "all"], ["f", "patch preview"], ["c", "PR comment"], ...scroll, ["q", "close"]],
      [["↑↓", "move"], ["space", "select"], ["a", "all"], ["f", "patch"], ["c", "comment"], ...scroll, ["q", "close"]],
      [["space", "select"], ["f", "patch"], ["c", "comment"], ["q", "close"]],
      [["space", "select"], ["q", "close"]],
    ];
    const rendered = variants.map((hints) => keyHints(hints, this.theme));
    return rendered.find((hints) => visibleWidth(hints) <= inner - 2) ?? rendered[rendered.length - 1] ?? "";
  }

  private moveCursor(delta: number): void {
    if (this.issues.length === 0) return;
    const next = Math.min(this.issues.length - 1, Math.max(0, this.cursor + delta));
    if (next !== this.cursor) this.detailScroll = 0;
    this.cursor = next;
  }

  private toggleCurrent(): void {
    const issue = this.issues[this.cursor];
    if (!issue) return;
    if (this.selected.has(issue.id)) this.selected.delete(issue.id);
    else this.selected.add(issue.id);
  }

  private toggleAll(): void {
    const allSelected = this.issues.length > 0 && this.issues.every((issue) => this.selected.has(issue.id));
    this.selected.clear();
    if (!allSelected) for (const issue of this.issues) this.selected.add(issue.id);
  }

  private finish(action: "fix" | "comment"): void {
    const issueIds = this.selectedIssueIds();
    if (issueIds.length === 0) {
      this.warning = `Select findings first (space or a), then press ${action === "fix" ? "f" : "c"}`;
      return;
    }
    if (action === "comment" && !this.issues.some((issue) => this.selected.has(issue.id) && isCommentableIssue(issue))) {
      this.warning = "None of the selected findings has a file and line to comment on";
      return;
    }
    this.done({ action, issueIds });
  }

  /** Selected ids in report order, which keeps follow-up prompts and comments stable. */
  private selectedIssueIds(): string[] {
    return this.reportOrder.filter((issue) => this.selected.has(issue.id)).map((issue) => issue.id);
  }
}
