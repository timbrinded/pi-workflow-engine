import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateDisplay, type WorkflowThemeColor } from "../ui/workflow-format.ts";
import { formatIssueLocation, type ReviewIssue } from "./review-issues.ts";

export interface RenderIssuesTableOptions {
  readonly maxRows?: number;
}

const DEFAULT_MAX_ROWS = 12;
const ID_WIDTH = 4;
const SEVERITY_WIDTH = 4;
const CONFIDENCE_WIDTH = 4;
const CATEGORY_WIDTH = 8;
const LOCATION_WIDTH = 30;
const SUMMARY_WIDTH = 58;

export function renderIssuesTable(issues: readonly ReviewIssue[], theme: Theme, options: RenderIssuesTableOptions = {}): string {
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const visible = maxRows >= 0 ? issues.slice(0, maxRows) : issues;
  const lines = [
    renderRow(["ID", "Sev", "Conf", "Cat", "Location", "Summary"], theme.fg("dim", "│"), theme, true),
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
        false,
        issue,
      ),
    );
  }

  if (issues.length > visible.length) {
    lines.push(theme.fg("dim", `… ${issues.length - visible.length} more finding(s)`));
  }

  return lines.join("\n");
}

export function renderIssueDetails(issue: ReviewIssue, theme: Theme): string {
  const finding = issue.finding;
  const lines = [
    `${theme.fg("accent", issue.id)} ${theme.fg("text", finding.summary)}`,
    `  ${theme.fg("dim", "Location:")} ${theme.fg("muted", formatIssueLocation(issue))}`,
    `  ${theme.fg("dim", "Category:")} ${theme.fg("muted", finding.category)} ${theme.fg("dim", "Severity:")} ${theme.fg(severityColor(finding.severity), finding.severity)} ${theme.fg("dim", "Confidence:")} ${theme.fg(confidenceColor(finding.confidence), finding.confidence)}`,
    `  ${theme.fg("dim", "Impact:")} ${theme.fg("muted", finding.impact)}`,
    `  ${theme.fg("dim", "Evidence:")} ${theme.fg("muted", finding.evidence.join("; ") || "(none cited)")}`,
    `  ${theme.fg("dim", "Recommendation:")} ${theme.fg("muted", finding.recommendation)}`,
  ];
  return lines.join("\n");
}

function renderRow(
  cells: readonly [string, string, string, string, string, string],
  separator: string,
  theme: Theme,
  header: boolean,
  issue?: ReviewIssue,
): string {
  const rendered = [
    cell(cells[0], ID_WIDTH),
    colorCell(cell(cells[1], SEVERITY_WIDTH), header ? "dim" : severityColor(issue?.finding.severity ?? "low"), theme),
    colorCell(cell(cells[2], CONFIDENCE_WIDTH), header ? "dim" : confidenceColor(issue?.finding.confidence ?? "low"), theme),
    cell(cells[3], CATEGORY_WIDTH),
    cell(cells[4], LOCATION_WIDTH),
    cell(cells[5], SUMMARY_WIDTH),
  ];
  if (header) {
    return rendered.map((entry) => theme.fg("dim", entry)).join(` ${separator} `);
  }
  return rendered.join(` ${separator} `);
}

function cell(value: string, width: number): string {
  return truncateDisplay(value, width).padEnd(width, " ");
}

function colorCell(value: string, color: WorkflowThemeColor, theme: Theme): string {
  return theme.fg(color, value);
}

function renderSeparator(): string {
  return [ID_WIDTH, SEVERITY_WIDTH, CONFIDENCE_WIDTH, CATEGORY_WIDTH, LOCATION_WIDTH, SUMMARY_WIDTH].map((width) => "─".repeat(width)).join("─┼─");
}

function severityColor(severity: ReviewIssue["finding"]["severity"]): WorkflowThemeColor {
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
