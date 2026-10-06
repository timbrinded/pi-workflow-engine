import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { dot, fit, GLYPH, hangingWrap, severityBadge, severityRank, truncatePath } from "../ui/kit.ts";
import type { ReviewIssue } from "./review-issues.ts";

/** Most severe first; report order (and so the stable R-number) breaks ties. */
export function sortIssuesForDisplay(issues: readonly ReviewIssue[]): ReviewIssue[] {
  return issues
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => severityRank(a.issue.finding.severity) - severityRank(b.issue.finding.severity) || a.index - b.index)
    .map(({ issue }) => issue);
}

/** `src/cache.ts:13`, without the symbol; the detail view shows the symbol on its own. */
export function issuePath(issue: ReviewIssue): string {
  if (!issue.file) return "no location";
  return issue.line === undefined ? issue.file : `${issue.file}:${issue.line}`;
}

/**
 * One aligned row: `HIGH R003  src/cache.ts:13      The parser accepts an empty value…`.
 * `pathColumn` (from `findingPathColumn`) narrows the location column to the paths actually listed.
 */
export function renderFindingRow(issue: ReviewIssue, width: number, theme: Theme, pathColumn?: number): string {
  const head = `${severityBadge(issue.finding.severity, theme)} ${theme.fg("dim", issue.id)}`;
  const room = Math.max(0, width - visibleWidth(head) - 2);
  const pathWidth = Math.min(pathColumn ?? Number.POSITIVE_INFINITY, maxPathWidth(room));
  if (room < pathWidth + 10) return fit(`${head}  ${theme.fg("text", issue.finding.summary)}`, width);
  const path = theme.fg("accent", fit(truncatePath(issuePath(issue), pathWidth), pathWidth));
  return fit(`${head}  ${path}  ${theme.fg("text", issue.finding.summary)}`, width);
}

function maxPathWidth(room: number): number {
  return Math.min(Math.max(12, Math.floor(room * 0.32)), 34);
}

/** A location column as wide as the longest listed path, never below 12 columns. */
export function findingPathColumn(issues: readonly ReviewIssue[]): number {
  return Math.max(12, ...issues.map((issue) => visibleWidth(issuePath(issue))));
}

const LABEL_WIDTH = 10;

/** The full finding: headline, wrapped summary, then aligned Location / Impact / Evidence / Fix sections. */
export function renderFindingDetail(issue: ReviewIssue, width: number, theme: Theme): string[] {
  const finding = issue.finding;
  const meta = [finding.category, `confidence ${finding.confidence}`, finding.verdict?.toLowerCase()].filter(Boolean).join(dot(theme));
  const lines = [
    `${severityBadge(finding.severity, theme)} ${theme.fg("accent", theme.bold(issue.id))}${dot(theme)}${theme.fg("muted", meta)}`,
    ...hangingWrap(theme.bold(finding.summary), width),
    "",
  ];
  const location = [theme.fg("accent", issuePath(issue)), issue.symbol ? theme.fg("muted", issue.symbol) : undefined].filter(Boolean).join(dot(theme));
  lines.push(...labelledLines("Location", [location], width, theme));
  lines.push(...labelledLines("Impact", [finding.impact], width, theme));
  const evidence = finding.evidence.length > 0 ? finding.evidence.map((item) => `${GLYPH.bullet} ${item}`) : [theme.fg("dim", "none cited")];
  lines.push(...labelledLines("Evidence", evidence, width, theme, "  "));
  lines.push(...labelledLines("Fix", [finding.recommendation], width, theme));
  return lines;
}

/** A dim label column (10 wide) with each item wrapped beside it, so result sections align with finding details. */
export function labelledLines(label: string, items: readonly string[], width: number, theme: Theme, itemIndent = ""): string[] {
  const first = theme.fg("dim", label.padEnd(LABEL_WIDTH, " "));
  const rest = " ".repeat(LABEL_WIDTH);
  return items.flatMap((item, index) => hangingWrap(item, width, index === 0 ? first : rest, rest + itemIndent));
}
