import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatCount } from "../text.ts";
import type { WorkflowUsageSnapshot } from "../usage.ts";

/**
 * The extension's shared visual language. Every screen draws status, severity, usage, hints and
 * frames through these helpers so the live widget, result messages and overlays read as one product.
 */

export type ThemeColor = Parameters<Theme["fg"]>[0];

export const GLYPH = {
  done: "✓",
  failed: "✗",
  running: "●",
  queued: "○",
  warning: "⚠",
  bullet: "•",
  cursor: "›",
  workflow: "◆",
  arrow: "→",
} as const;

export const SEPARATOR = " · ";

export function dot(theme: Theme): string {
  return theme.fg("dim", SEPARATOR);
}

export function joinParts(parts: readonly (string | undefined | false)[], theme: Theme): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(dot(theme));
}

export type Severity = "high" | "medium" | "low";

export function severityColor(severity: Severity): ThemeColor {
  return severity === "high" ? "error" : severity === "medium" ? "warning" : "muted";
}

const SEVERITY_LABEL: Record<Severity, string> = { high: "HIGH", medium: "MED", low: "LOW" };

/** Fixed-width (4 columns) severity badge so finding rows align. */
export function severityBadge(severity: Severity, theme: Theme): string {
  const label = SEVERITY_LABEL[severity].padEnd(4, " ");
  return severity === "high" ? theme.fg("error", theme.bold(label)) : theme.fg(severityColor(severity), label);
}

export function severityRank(severity: Severity): number {
  return severity === "high" ? 0 : severity === "medium" ? 1 : 2;
}

/** `━━━━━───` style bar; empty when there is nothing to measure. */
export function progressBar(done: number, total: number, width: number, theme: Theme): string {
  if (total <= 0 || width <= 0) return "";
  const filled = Math.round((Math.min(done, total) / total) * width);
  return theme.fg("accent", "━".repeat(filled)) + theme.fg("dim", "─".repeat(width - filled));
}

/** `↑34k ↓1.2k · $0.02`: input (fresh + cache) and output tokens, cost only when known. */
export function compactUsage(usage: WorkflowUsageSnapshot | undefined, theme: Theme): string | undefined {
  if (!usage || usage.totals.totalTokens <= 0) return undefined;
  const { input, cacheRead, cacheWrite, output, cost } = usage.totals;
  const parts = [`↑${formatCount(input + cacheRead + cacheWrite)}`, `↓${formatCount(output)}`].join(" ");
  return cost.total > 0 ? joinParts([parts, formatCost(cost.total)], theme) : parts;
}

export function formatCost(dollars: number): string {
  if (dollars <= 0) return "$0";
  if (dollars < 0.01) return "<$0.01";
  return `$${dollars < 10 ? dollars.toFixed(2) : dollars.toFixed(1)}`;
}

/** `5s ago`, `3m ago`, `2h ago`, `4d ago`. */
export function relativeTime(fromMs: number, nowMs = Date.now()): string {
  const seconds = Math.max(0, Math.round((nowMs - fromMs) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Keeps the file name and line: `src/very/deep/file.ts:12` → `…/deep/file.ts:12`. */
export function truncatePath(path: string, width: number): string {
  if (visibleWidth(path) <= width) return path;
  if (width <= 1) return "…".slice(0, width);
  const segments = path.split("/");
  let tail = segments.pop() ?? path;
  while (segments.length > 0 && visibleWidth(`…/${segments[segments.length - 1]}/${tail}`) <= width) {
    tail = `${segments.pop()}/${tail}`;
  }
  const candidate = `…/${tail}`;
  return visibleWidth(candidate) <= width ? candidate : `…${tail.slice(-(width - 1))}`;
}

/** Pads (or truncates) styled text to an exact visible width. */
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

export function padStartVisible(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - visibleWidth(text))) + text;
}

/** Left and right content on one line, the left side truncated first. */
export function spread(left: string, right: string, width: number): string {
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "…");
  const leftRoom = width - rightWidth - 1;
  return fit(left, leftRoom) + " " + right;
}

/** Wraps `text` to `width`, prefixing the first line with `first` and the rest with matching spaces. */
export function hangingWrap(text: string, width: number, first = "", rest = " ".repeat(visibleWidth(first))): string[] {
  const available = Math.max(8, width - visibleWidth(first));
  const lines = wrapTextWithAnsi(text, available);
  if (lines.length === 0) return [first.trimEnd()];
  return lines.map((line, index) => `${index === 0 ? first : rest}${line}`);
}

/** `↑↓ move · enter open · q close` in pi's hint style (dim key, muted description). */
export function keyHints(pairs: readonly (readonly [key: string, description: string])[], theme: Theme): string {
  return pairs.map(([key, description]) => `${theme.fg("dim", key)} ${theme.fg("muted", description)}`).join(dot(theme));
}

export interface Tab {
  readonly label: string;
  readonly count?: number;
}

/** A tab strip; the active tab is bold on the selection background. */
export function tabBar(tabs: readonly Tab[], active: number, theme: Theme): string {
  return tabs
    .map((tab, index) => {
      const count = tab.count === undefined ? "" : ` ${tab.count}`;
      if (index === active) return theme.bg("selectedBg", theme.bold(` ${tab.label}${count} `));
      return ` ${theme.fg("muted", tab.label)}${theme.fg("dim", count)} `;
    })
    .join(theme.fg("dim", "│"));
}

export interface FrameOptions {
  readonly title: string;
  readonly right?: string;
  readonly footer?: string;
  readonly borderColor?: ThemeColor;
}

/**
 * A rounded overlay frame with the title set into the top border and hints into the bottom one:
 * `╭─ title ─────── right ─╮` … `╰─ hints ──────────────╯`. Body lines are padded to the width.
 */
export function frame(body: readonly string[], width: number, theme: Theme, options: FrameOptions): string[] {
  const outer = Math.max(8, width);
  const inner = outer - 4;
  const border = (text: string) => theme.fg(options.borderColor ?? "borderAccent", text);
  return [
    borderLine("╭", "╮", options.title, options.right, outer, border),
    ...body.map((line) => `${border("│")} ${fit(line, inner)} ${border("│")}`),
    borderLine("╰", "╯", options.footer, undefined, outer, border),
  ];
}

function borderLine(
  left: string,
  right: string,
  label: string | undefined,
  rightLabel: string | undefined,
  width: number,
  border: (text: string) => string,
): string {
  const room = width - 2;
  const leftPart = label ? `${border("─")} ${truncateToWidth(label, Math.max(0, room - 4), "…")} ` : "";
  const rightPart = rightLabel ? ` ${truncateToWidth(rightLabel, Math.max(0, room - visibleWidth(leftPart) - 4), "…")} ${border("─")}` : "";
  const fill = Math.max(0, room - visibleWidth(leftPart) - visibleWidth(rightPart));
  return `${border(left)}${leftPart}${border("─".repeat(fill))}${rightPart}${border(right)}`;
}

/** Overlay height: content-sized between a floor and 80% of the terminal, never more than `max`. */
export function overlayHeight(terminalRows: number, contentRows: number, options: { min?: number; max?: number } = {}): number {
  const ceiling = Math.max(6, Math.min(options.max ?? 40, Math.floor(terminalRows * 0.8), terminalRows - 2));
  return Math.max(Math.min(options.min ?? 10, ceiling), Math.min(ceiling, contentRows));
}

/** A one-line scroll hint shown only when content is clipped: `↑ 3 more` / `↓ 12 more`. */
export function scrollHint(above: number, below: number, theme: Theme): string | undefined {
  const parts = [above > 0 ? `↑ ${above} more` : undefined, below > 0 ? `↓ ${below} more` : undefined];
  return parts.some(Boolean) ? theme.fg("dim", parts.filter(Boolean).join("  ")) : undefined;
}
