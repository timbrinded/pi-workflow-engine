import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { isFiniteNumber, isRecord } from "../guards.ts";
import { labelledLines } from "../review/review-format.ts";
import { formatCount } from "../text.ts";
import { isWorkflowUsageSnapshot } from "../usage.ts";
import { formatCost, GLYPH, joinParts, keyHints, spread } from "./kit.ts";
import { formatDuration } from "./workflow-format.ts";

/**
 * Layout shared by every workflow result screen: a status header with right-aligned run metadata,
 * an indented body, labelled detail rows, and a hint footer. Everything is drawn for one width.
 */

/** What the result renderers read. Persisted message details are unvalidated, so `usage` stays `unknown`. */
export interface WorkflowResultView {
  readonly name: string;
  readonly result: unknown;
  readonly usage?: unknown;
  readonly perf?: unknown;
  readonly runId?: string;
  readonly resumedFromRunId?: string;
  readonly startedAt?: unknown;
  readonly completedAt?: unknown;
  /** Set on background deliveries, together with the run's final `status`. */
  readonly background?: unknown;
  readonly status?: unknown;
}

/** Keys the result footer advertises; a missing key hides its hint. */
export interface WorkflowResultHints {
  /** Opens the code-review findings viewer: the configured shortcut, or `/workflow:results` when unbound. */
  readonly triage?: string;
  /** pi's expand-tool-output key (`app.tools.expand`). */
  readonly expand?: string;
}

export interface ResultFrame {
  readonly view: WorkflowResultView;
  readonly expanded: boolean;
  readonly width: number;
  readonly theme: Theme;
  readonly hints: WorkflowResultHints;
}

export type HintPair = readonly [key: string, description: string];

export const INDENT = "  ";

/** Body width once the two-column indent is taken. */
export function innerWidth(frame: ResultFrame): number {
  return Math.max(10, frame.width - INDENT.length);
}

/** Renders lines for the width pi offers and caches them until the width or theme changes. */
export class LinesComponent implements Component {
  private cache: { readonly width: number; readonly lines: string[] } | undefined;

  constructor(private readonly draw: (width: number) => string[]) {}

  render(width: number): string[] {
    if (this.cache?.width !== width) {
      this.cache = { width, lines: this.draw(width).map((line) => truncateToWidth(line, width, "…")) };
    }
    return this.cache.lines;
  }

  invalidate(): void {
    this.cache = undefined;
  }
}

/**
 * `✓ code-review  3 findings · 1 high              4s · ↑34k ↓1k · $0.02`. Run metadata is right-aligned.
 * When the line is too narrow, cost and tokens go first, then the optional facts, then the duration,
 * so the essential facts never wrap.
 */
export function headerLine(glyph: string, frame: ResultFrame, facts: readonly (string | undefined)[], optionalFacts: readonly string[] = []): string {
  const { theme, width } = frame;
  const leftFor = (parts: readonly (string | undefined)[]) => {
    const joined = joinParts(parts, theme);
    return `${glyph} ${theme.bold(frame.view.name)}${joined ? `  ${joined}` : ""}`;
  };
  const meta = runMeta(frame);
  const variants: { readonly left: string; readonly meta: number }[] = [];
  const full = leftFor([...facts, ...optionalFacts]);
  for (let count = meta.length; count >= 1; count--) variants.push({ left: full, meta: count });
  if (optionalFacts.length > 0) variants.push({ left: leftFor(facts), meta: Math.min(1, meta.length) });
  for (const variant of variants) {
    const right = joinParts(meta.slice(0, variant.meta), theme);
    if (visibleWidth(variant.left) + 2 + visibleWidth(right) <= width) return spread(variant.left, right, width);
  }
  const left = visibleWidth(full) <= width || optionalFacts.length === 0 ? full : leftFor(facts);
  return truncateToWidth(left, width, "…");
}

/** Duration, then tokens, then cost; zeros and unknowns are left out. */
function runMeta({ view, theme }: ResultFrame): string[] {
  const parts: string[] = [];
  const duration = runDuration(view);
  if (duration !== undefined) parts.push(theme.fg("muted", formatDuration(duration)));
  if (isWorkflowUsageSnapshot(view.usage) && view.usage.totals.totalTokens > 0) {
    const { input, cacheRead, cacheWrite, output, cost } = view.usage.totals;
    parts.push(theme.fg("muted", `↑${formatCount(input + cacheRead + cacheWrite)} ↓${formatCount(output)}`));
    if (cost.total > 0) parts.push(theme.fg("muted", formatCost(cost.total)));
  }
  return parts;
}

function runDuration(view: WorkflowResultView): number | undefined {
  if (!isFiniteNumber(view.startedAt) || !isFiniteNumber(view.completedAt)) return undefined;
  const ms = view.completedAt - view.startedAt;
  return ms > 0 ? ms : undefined;
}

export function agentCount(view: WorkflowResultView): number {
  return isWorkflowUsageSnapshot(view.usage) ? view.usage.agents.length : 0;
}

/** `3 findings`, `1 finding`. */
export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** Wraps plain text to `width`, styling each line, and ends a clipped paragraph with `…`. */
export function paragraph(text: string, width: number, style: (line: string) => string, maxLines = Number.POSITIVE_INFINITY): string[] {
  const lines = wrapTextWithAnsi(text.trim(), Math.max(8, width));
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${truncateToWidth(lines[maxLines - 1] ?? "", Math.max(1, width - 1), "")}…`;
  }
  return lines.map(style);
}

/** True when `paragraph` would clip the text at `maxLines`. */
export function clips(text: string, width: number, maxLines: number): boolean {
  return wrapTextWithAnsi(text.trim(), Math.max(8, width)).length > maxLines;
}

export function indent(lines: readonly string[]): string[] {
  return lines.map((line) => (line ? `${INDENT}${line}` : line));
}

/** Labelled rows aligned with finding details: `Run       3cfb22c2-… · resumed from 1a2b3c4d`. */
export function labelled(frame: ResultFrame, label: string, items: readonly string[], itemIndent = ""): string[] {
  if (items.length === 0) return [];
  return indent(labelledLines(label, items, innerWidth(frame), frame.theme, itemIndent));
}

export function bullets(items: readonly string[]): string[] {
  return items.map((item) => `${GLYPH.bullet} ${item}`);
}

/** The full run identity (with the agent count unless the header has it) and perf samples, shown only when expanded. */
export function runDetailRows(frame: ResultFrame, options: { readonly agents: boolean } = { agents: true }): string[] {
  const { view, theme } = frame;
  const agents = options.agents ? agentCount(view) : 0;
  const run = view.runId
    ? joinParts([
      theme.fg("muted", view.runId),
      view.resumedFromRunId ? theme.fg("muted", `resumed from ${shortRunId(view.resumedFromRunId)}`) : undefined,
      view.background === true ? theme.fg("muted", "background") : undefined,
      agents > 0 ? theme.fg("muted", plural(agents, "agent")) : undefined,
    ], theme)
    : undefined;
  const perf = perfSamples(view.perf);
  return [
    ...(run ? labelled(frame, "Run", [run]) : []),
    ...labelled(frame, "Perf", perf.length > 0 ? [theme.fg("muted", perf.join(" · "))] : []),
  ];
}

function perfSamples(perf: unknown): string[] {
  if (!isRecord(perf) || !Array.isArray(perf.aggregates)) return [];
  return perf.aggregates
    .flatMap((aggregate: unknown) => (isRecord(aggregate) && typeof aggregate.name === "string" && isFiniteNumber(aggregate.total)
      ? [`${aggregate.name} ${Math.round(aggregate.total)}ms`]
      : []))
    .slice(0, 6);
}

export function shortRunId(runId: string): string {
  return runId.slice(0, 8);
}

/**
 * `ctrl+shift+r triage · ctrl+o expand · run 3cfb22c2`. Collapsed results name the short run id;
 * expanded ones show the full id in the Run row instead, so it is not repeated here.
 */
export function footerLine(frame: ResultFrame, pairs: readonly HintPair[], options: { readonly more: boolean }): string | undefined {
  const { view, theme, hints, expanded } = frame;
  const allPairs = [...pairs];
  if (hints.expand && (expanded || options.more)) allPairs.push([hints.expand, expanded ? "collapse" : "expand"]);
  const keys = allPairs.length > 0 ? keyHints(allPairs, theme) : undefined;
  const facts = expanded ? [] : [
    view.runId ? theme.fg("dim", `run ${shortRunId(view.runId)}`) : undefined,
    view.background === true ? theme.fg("dim", "background") : undefined,
  ];
  // The run facts give way before any key hint is cut.
  for (let count = facts.length; count >= 0; count--) {
    const line = joinParts([keys, ...facts.slice(0, count)], theme);
    if (!line) return undefined;
    if (count === 0 || visibleWidth(line) <= innerWidth(frame)) return `${INDENT}${line}`;
  }
  return undefined;
}
