import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink, truncateToWidth } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";
import { ResearchReportSchema, type ResearchReport, type ResearchReportEntry, type ResearchSource } from "../research-contract.ts";
import { GLYPH, hangingWrap, joinParts } from "./kit.ts";
import {
  bullets,
  footerLine,
  headerLine,
  indent,
  innerWidth,
  paragraph,
  plural,
  runDetailRows,
  type ResultFrame,
} from "./result-layout.ts";

const COLLAPSED_ANSWER_LINES = 4;
const COLLAPSED_CLAIMS = 3;
const COLLAPSED_CLAIM_LINES = 2;

export function isResearchReport(value: unknown): value is ResearchReport {
  return Value.Check(ResearchReportSchema, value);
}

interface ClaimGroup {
  readonly title: string;
  readonly fact: string;
  readonly tag: string;
  readonly entries: readonly ResearchReportEntry[];
}

/** Numbers each distinct source once, in report order, so claims cite `[1][2]` and the list matches. */
class SourceIndex {
  readonly sources: ResearchSource[] = [];
  private readonly numbers = new Map<string, number>();

  constructor(sources: readonly ResearchSource[]) {
    for (const source of sources) this.number(source);
  }

  number(source: ResearchSource): number {
    const key = source.url.trim();
    const existing = this.numbers.get(key);
    if (existing !== undefined) return existing;
    this.sources.push(source);
    this.numbers.set(key, this.sources.length);
    return this.sources.length;
  }
}

/**
 * The research report: the answer, numbered claims with `[n]` citations, the non-empty conflicting and
 * uncertain groups, and the numbered source list. Collapsed keeps the answer and the top claims.
 */
export function renderResearchResult(frame: ResultFrame, report: ResearchReport): string[] {
  const { expanded, theme } = frame;
  const width = innerWidth(frame);
  const groups: ClaimGroup[] = [
    { title: "Supported claims", fact: "supported", tag: "", entries: report.supportedClaims },
    { title: "Conflicting evidence", fact: "conflicting", tag: "conflicting", entries: report.conflictingEvidence },
    { title: "Uncertain", fact: "uncertain", tag: "uncertain", entries: report.uncertainties },
    { title: "Inferences", fact: "inferred", tag: "inference", entries: report.inferences },
  ];
  const sources = new SourceIndex(report.sources);
  const markers = new Map<ResearchReportEntry, string>();
  for (const group of groups) {
    for (const entry of group.entries) markers.set(entry, citationMarkers(entry, sources, theme));
  }

  const claimCount = groups.reduce((sum, group) => sum + group.entries.length, 0);
  const facts = [
    claimCount === 0 ? theme.fg("warning", "no verified claims") : undefined,
    ...groups.map((group) => (group.entries.length > 0 ? theme.fg(group.fact === "supported" ? "text" : "warning", `${group.entries.length} ${group.fact}`) : undefined)),
  ];
  const sourceFacts = sources.sources.length > 0 ? [theme.fg("muted", plural(sources.sources.length, "source"))] : [];
  const glyph = claimCount > 0 ? theme.fg("success", GLYPH.done) : theme.fg("warning", GLYPH.warning);
  const lines = [headerLine(glyph, frame, facts, sourceFacts)];
  if (report.answer.trim()) {
    lines.push(...indent(paragraph(report.answer, width, (line) => theme.fg("text", line), expanded ? undefined : COLLAPSED_ANSWER_LINES)));
  }

  if (expanded) {
    for (const group of groups) {
      if (group.entries.length === 0) continue;
      lines.push("", ...indent([heading(group.title, group.entries.length, theme)]));
      group.entries.forEach((entry, index) => lines.push(...indent(claimLines(entry, index, markers.get(entry) ?? "", width, theme, true))));
    }
    if (sources.sources.length > 0) {
      lines.push("", ...indent([heading("Sources", sources.sources.length, theme)]));
      sources.sources.forEach((source, index) => lines.push(...indent(sourceLines(source, index + 1, width, theme))));
    }
    for (const [title, items] of [["Limitations", report.limitations], ["Next steps", report.nextSteps]] as const) {
      if (items.length === 0) continue;
      lines.push("", ...indent([heading(title, undefined, theme)]));
      lines.push(...indent(bullets(items).flatMap((item) => hangingWrap(theme.fg("muted", item), width, "", "  "))));
    }
    const rows = runDetailRows(frame);
    if (rows.length > 0) lines.push("", ...rows);
  } else {
    const featured = featuredClaims(groups);
    if (featured.length > 0) {
      lines.push("");
      featured.slice(0, COLLAPSED_CLAIMS).forEach(({ entry, tag }, index) => {
        const marker = joinParts([markers.get(entry), tag ? theme.fg("warning", tag) : undefined], theme);
        lines.push(...indent(claimLines(entry, index, marker, width, theme, false)));
      });
      const hidden = claimCount - Math.min(COLLAPSED_CLAIMS, featured.length);
      if (hidden > 0) lines.push(...indent([theme.fg("dim", `+${plural(hidden, "more claim", "more claims")}`)]));
    } else if (report.nextSteps[0]) {
      lines.push(...indent(hangingWrap(theme.fg("muted", report.nextSteps[0]), width, theme.fg("dim", `${GLYPH.arrow} `))));
    }
  }

  const footer = footerLine(frame, [], { more: true });
  if (footer) lines.push(footer);
  return lines;
}

/** Supported claims lead; without any, the other groups stand in, each tagged with its kind. */
function featuredClaims(groups: readonly ClaimGroup[]): { readonly entry: ResearchReportEntry; readonly tag: string }[] {
  const [supported, ...rest] = groups;
  if (supported && supported.entries.length > 0) return supported.entries.map((entry) => ({ entry, tag: "" }));
  return rest.flatMap((group) => group.entries.map((entry) => ({ entry, tag: group.tag })));
}

function citationMarkers(entry: ResearchReportEntry, sources: SourceIndex, theme: Theme): string {
  const numbers = [...new Set(entry.citations.map((citation) => sources.number(citation)))].sort((a, b) => a - b);
  return numbers.map((number) => theme.fg("accent", `[${number}]`)).join("");
}

function heading(title: string, count: number | undefined, theme: Theme): string {
  return `${theme.bold(title)}${count === undefined ? "" : theme.fg("dim", ` ${count}`)}`;
}

/** `1. claim [1][2]` with a hanging indent; expanded adds the explanation beneath. */
function claimLines(entry: ResearchReportEntry, index: number, marker: string, width: number, theme: Theme, expanded: boolean): string[] {
  const number = `${index + 1}. `;
  const rest = " ".repeat(number.length);
  const claim = `${theme.fg("text", entry.claim)}${marker ? ` ${marker}` : ""}`;
  const lines = hangingWrap(claim, width, theme.fg("dim", number), rest);
  if (!expanded) return clampLines(lines, COLLAPSED_CLAIM_LINES, width);
  return [...lines, ...hangingWrap(theme.fg("muted", entry.explanation), width, rest)];
}

function clampLines(lines: string[], max: number, width: number): string[] {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  kept[max - 1] = `${truncateToWidth(kept[max - 1] ?? "", Math.max(1, width - 1), "")}…`;
  return kept;
}

/** `[1] Title · docs.example.dev · 2026-09-14`; the title is a link where the terminal supports one, else the URL follows. */
function sourceLines(source: ResearchSource, number: number, width: number, theme: Theme): string[] {
  const linkable = getCapabilities().hyperlinks;
  const title = theme.fg("accent", source.title.trim());
  const head = theme.fg("dim", `[${number}] `);
  const rest = " ".repeat(`[${number}] `.length);
  const host = sourceHost(source.url);
  const date = source.publishedAt?.trim();
  const line = joinParts([
    linkable ? hyperlink(title, source.url) : title,
    host ? theme.fg("muted", host) : undefined,
    date ? theme.fg("muted", date) : undefined,
  ], theme);
  const lines = hangingWrap(line, width, head, rest);
  if (!linkable) lines.push(...hangingWrap(theme.fg("dim", source.url), width, rest));
  return lines;
}

function sourceHost(url: string): string | undefined {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}
