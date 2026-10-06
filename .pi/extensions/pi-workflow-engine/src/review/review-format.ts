import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { truncateDisplay, type WorkflowThemeColor } from "../ui/workflow-format.ts";
import { formatIssueLocation, type ReviewIssue } from "./review-issues.ts";

export interface RenderIssuesTableOptions {
  readonly maxRows?: number;
}

const DEFAULT_MAX_ROWS = 12;
const ID_WIDTH = 4;
const SEVERITY_WIDTH = 6;
const CONFIDENCE_WIDTH = 6;
const CATEGORY_WIDTH = 8;
const LOCATION_WIDTH = 30;
const SUMMARY_WIDTH = 58;
const COLUMN_WIDTHS = [ID_WIDTH, SEVERITY_WIDTH, CONFIDENCE_WIDTH, CATEGORY_WIDTH, LOCATION_WIDTH, SUMMARY_WIDTH] as const;

export function renderIssuesTable(issues: readonly ReviewIssue[], theme: Theme, options: RenderIssuesTableOptions = {}): string {
  const visible = issues.slice(0, options.maxRows ?? DEFAULT_MAX_ROWS);
  const lines = [
    renderRow(["ID", "Sev", "Conf", "Cat", "Location", "Summary"], theme.fg("dim", "│"), theme),
    theme.fg("dim", renderSeparator()),
  ];

  for (const issue of visible) {
    lines.push(
      renderRow(
        [
          issue.id,
          issue.finding.severity,
          issue.finding.confidence,
          issue.finding.category,
          formatIssueLocation(issue),
          issue.finding.summary,
        ],
        theme.fg("dim", "│"),
        theme,
        issue,
      ),
    );
  }

  if (issues.length > visible.length) {
    lines.push(theme.fg("dim", `… ${issues.length - visible.length} more finding(s)`));
  }

  return lines.join("\n");
}

export function renderIssueDetailLines(issue: ReviewIssue, theme: Theme, width: number): string[] {
  const finding = issue.finding;
  const metadata = `${finding.category} · severity ${finding.severity} · confidence ${finding.confidence}${finding.verdict ? ` · ${finding.verdict}` : ""}`;
  const lines = [`${theme.fg("accent", issue.id)} ${theme.fg("text", finding.summary)}`];
  lines.push(...fieldLines("Metadata", metadata, width, theme));
  if (finding.sourceCandidateIds?.length) lines.push(...fieldLines("Sources", finding.sourceCandidateIds.join(", "), width, theme));
  lines.push(...fieldLines("Location", formatIssueLocation(issue), width, theme, "accent"));
  lines.push(...fieldLines("Impact", finding.impact, width, theme));
  lines.push(...fieldLines("Evidence", finding.evidence.join("; ") || "(none cited)", width, theme));
  lines.push(...fieldLines("Recommendation", finding.recommendation, width, theme));
  return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(10, width)));
}

function fieldLines(label: string, value: string, width: number, theme: Theme, valueColor: WorkflowThemeColor = "muted"): string[] {
  const prefix = `  ${theme.fg("dim", `${label}:`)}`;
  const separator = " ";
  const valueText = theme.fg(valueColor, value);
  const available = Math.max(10, width - visibleWidth(`${label}:  `) - 2);
  const wrapped = wrapTextWithAnsi(valueText, available);
  if (wrapped.length === 0) return [`${prefix}${separator}`];
  const continuation = " ".repeat(visibleWidth(`${label}:  `) + 2);
  return wrapped.map((line, index) => (index === 0 ? `${prefix}${separator}${line}` : `${continuation}${line}`));
}

/** A header row (no issue) is dimmed; issue rows colour their severity and confidence cells. */
function renderRow(
  cells: readonly [string, string, string, string, string, string],
  separator: string,
  theme: Theme,
  issue?: ReviewIssue,
): string {
  const rendered = cells.map((value, index) => truncateDisplay(value, COLUMN_WIDTHS[index]).padEnd(COLUMN_WIDTHS[index], " "));
  if (!issue) return rendered.map((entry) => theme.fg("dim", entry)).join(` ${separator} `);
  rendered[1] = theme.fg(severityColor(issue.finding.severity), rendered[1]);
  rendered[2] = theme.fg(confidenceColor(issue.finding.confidence), rendered[2]);
  return rendered.join(` ${separator} `);
}

function renderSeparator(): string {
  return COLUMN_WIDTHS.map((width) => "─".repeat(width)).join("─┼─");
}

export function severityColor(severity: ReviewIssue["finding"]["severity"]): WorkflowThemeColor {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "muted";
  }
}

function confidenceColor(confidence: ReviewIssue["finding"]["confidence"]): WorkflowThemeColor {
  switch (confidence) {
    case "high":
      return "success";
    case "medium":
      return "warning";
    case "low":
      return "muted";
  }
}
