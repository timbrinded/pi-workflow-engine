import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { isAdvisoryReport, type AdvisoryReportWithStats } from "../advisory-schema.ts";
import { isRecord } from "../guards.ts";
import { findingPathColumn, renderFindingDetail, renderFindingRow, sortIssuesForDisplay } from "../review/review-format.ts";
import { toReviewIssues, type ReviewIssue } from "../review/review-issues.ts";
import { formatCount, prettyJson } from "../text.ts";
import { workflowResultSummary } from "../workflow-execution.ts";
import { GLYPH, joinParts, severityColor, type Severity } from "./kit.ts";
import { isResearchReport, renderResearchResult } from "./research-result-renderer.ts";
import {
  agentCount,
  bullets,
  clips,
  footerLine,
  headerLine,
  indent,
  innerWidth,
  labelled,
  LinesComponent,
  paragraph,
  plural,
  runDetailRows,
  type HintPair,
  type ResultFrame,
  type WorkflowResultHints,
  type WorkflowResultView,
} from "./result-layout.ts";

export type { WorkflowResultHints, WorkflowResultView } from "./result-layout.ts";

const COLLAPSED_SUMMARY_LINES = 2;
const COLLAPSED_GENERIC_LINES = 3;
const COLLAPSED_FINDINGS = 6;

/** Recognises persisted result-envelope details by the fields every envelope carries. */
export function isWorkflowResult(value: unknown): value is WorkflowResultView {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && "result" in value && typeof value.completedAt === "number";
}

/** The `workflow-result` message: the result on pi's custom-message background. */
export function renderWorkflowResult(view: WorkflowResultView, expanded: boolean, theme: Theme, hints: WorkflowResultHints = {}): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(workflowResultComponent(view, expanded, theme, hints));
  return box;
}

/** The bare result, for surfaces that already provide a shell (the workflow tool row). */
export function workflowResultComponent(view: WorkflowResultView, expanded: boolean, theme: Theme, hints: WorkflowResultHints = {}): Component {
  return new LinesComponent((width) => renderWorkflowResultLines(view, expanded, width, theme, hints));
}

export function renderWorkflowResultLines(
  view: WorkflowResultView,
  expanded: boolean,
  width: number,
  theme: Theme,
  hints: WorkflowResultHints = {},
): string[] {
  const frame: ResultFrame = { view, expanded, width, theme, hints };
  const lines = view.background === true && isInterruptedState(view.status) ? renderInterruptedRun(frame, view.status)
    : isAdvisoryReport(view.result) ? renderAdvisoryResult(frame, view.result)
    : isResearchReport(view.result) ? renderResearchResult(frame, view.result)
    : renderGenericResult(frame);
  return lines.map((line) => truncateToWidth(line, width, "…"));
}

function renderAdvisoryResult(frame: ResultFrame, report: AdvisoryReportWithStats): string[] {
  const { view, expanded, theme, hints } = frame;
  const width = innerWidth(frame);
  const issues = sortIssuesForDisplay(toReviewIssues(report));
  const incomplete = report.status === "incomplete";
  const failures = incompleteStages(report.coverage ?? []);
  const [findings, ...severities] = findingFacts(issues, incomplete, theme);
  const facts = [
    incomplete ? theme.fg("warning", "incomplete") : undefined,
    ...failures.map((failure) => theme.fg("warning", failure)),
    findings,
  ];
  const glyph = incomplete ? theme.fg("warning", GLYPH.warning) : theme.fg("success", GLYPH.done);
  const lines = [
    headerLine(glyph, frame, facts, severities),
    ...indent(paragraph(report.summary, width, (line) => theme.fg("text", line), expanded ? undefined : COLLAPSED_SUMMARY_LINES)),
  ];
  const gaps = report.gaps ?? [];
  if (!expanded && gaps.length > 0) lines.push(...indent([gapLine(gaps, theme)]));

  if (issues.length > 0) {
    lines.push("");
    if (expanded) {
      issues.forEach((issue, index) => {
        if (index > 0) lines.push("");
        lines.push(...indent(renderFindingDetail(issue, width, theme)));
      });
    } else {
      const shown = issues.slice(0, COLLAPSED_FINDINGS);
      const column = findingPathColumn(shown);
      lines.push(...indent(shown.map((issue) => renderFindingRow(issue, width, theme, column))));
      const hidden = issues.length - COLLAPSED_FINDINGS;
      if (hidden > 0) lines.push(...indent([theme.fg("dim", `+${plural(hidden, "more finding", "more findings")}`)]));
    }
  }

  if (expanded) {
    const rows = [
      ...labelled(frame, "Coverage", coverageItems(report, theme)),
      ...labelled(frame, "Gaps", gaps.map((gap) => theme.fg("warning", `${GLYPH.failed} ${gap}`)), "  "),
      ...labelled(frame, "Funnel", funnelItems(report.stats, theme)),
      ...labelled(frame, "Follow-up", bullets(report.nextSteps), "  "),
      ...runDetailRows(frame),
    ];
    if (rows.length > 0) lines.push("", ...rows);
  }

  const pairs: HintPair[] = hints.triage && view.name === "code-review" && issues.length > 0 ? [[hints.triage, "triage"]] : [];
  const footer = footerLine(frame, pairs, { more: true });
  if (footer) lines.push(footer);
  return lines;
}

/** `3 findings · 1 high · 1 medium`, zero severities hidden; `no findings` when the report is clean. */
function findingFacts(issues: readonly ReviewIssue[], incomplete: boolean, theme: Theme): string[] {
  if (issues.length === 0) return [theme.fg(incomplete ? "warning" : "success", incomplete ? "no verified findings" : "no findings")];
  const severities: Severity[] = ["high", "medium", "low"];
  return [
    theme.fg("text", plural(issues.length, "finding")),
    ...severities.flatMap((severity) => {
      const count = issues.filter((issue) => issue.finding.severity === severity).length;
      return count > 0 ? [theme.fg(severityColor(severity), `${count} ${severity}`)] : [];
    }),
  ];
}

type AdvisoryCoverage = NonNullable<AdvisoryReportWithStats["coverage"]>[number];

const STAGE_AGENTS: Readonly<Record<string, string>> = { Find: "finders", Verify: "verifiers", Challenge: "challengers" };

/** `1 of 5 finders failed`, `Synthesize failed`: one phrase per stage that lost work. */
function incompleteStages(coverage: readonly AdvisoryCoverage[]): string[] {
  return coverage.flatMap((stage) => {
    const missing = stage.failed > 0 ? stage.failed : stage.expected - stage.completed;
    if (missing <= 0) return [];
    const outcome = stage.failed > 0 ? "failed" : "missing";
    if (stage.expected <= 1) return [`${stage.stage} ${outcome}`];
    return [`${missing} of ${stage.expected} ${STAGE_AGENTS[stage.stage] ?? `${stage.stage} branches`} ${outcome}`];
  });
}

/** The first coverage gap, with a count of the rest: `✗ Find/error-paths: provider failed · +1 more`. */
function gapLine(gaps: readonly string[], theme: Theme): string {
  const more = gaps.length > 1 ? theme.fg("dim", ` · +${gaps.length - 1} more`) : "";
  return `${theme.fg("error", GLYPH.failed)} ${theme.fg("warning", gaps[0] ?? "")}${more}`;
}

/** `9 of 10 branches complete · Find 4 of 5`: totals, then only the stages that lost work. */
function coverageItems(report: AdvisoryReportWithStats, theme: Theme): string[] {
  const coverage = report.coverage ?? [];
  if (coverage.length === 0) return [];
  const expected = coverage.reduce((sum, stage) => sum + stage.expected, 0);
  const completed = coverage.reduce((sum, stage) => sum + stage.completed, 0);
  const lossy = coverage
    .filter((stage) => stage.completed < stage.expected)
    .map((stage) => theme.fg("warning", `${stage.stage} ${stage.completed} of ${stage.expected}${stage.failed > 0 ? ` (${stage.failed} failed)` : ""}`));
  return [joinParts([theme.fg(lossy.length > 0 ? "warning" : "muted", `${completed} of ${plural(expected, "branch", "branches")} complete`), ...lossy], theme)];
}

const FUNNEL_STAGES: readonly (readonly [key: string, singular: string, pluralLabel: string])[] = [
  ["files", "file", "files"],
  ["candidates", "candidate", "candidates"],
  ["verified", "verified", "verified"],
  ["kept", "kept", "kept"],
];

/** `3 files → 3 candidates → 3 verified → 3 kept · 1 refuted`, zero side counts hidden. */
function funnelItems(stats: AdvisoryReportWithStats["stats"], theme: Theme): string[] {
  if (!stats) return [];
  const known = new Set(FUNNEL_STAGES.map(([key]) => key));
  const stages = FUNNEL_STAGES.flatMap(([key, singular, pluralLabel]) => {
    const value = stats[key];
    if (value === undefined) return [];
    return [typeof value === "number" ? `${formatCount(value)} ${value === 1 ? singular : pluralLabel}` : `${value} ${pluralLabel}`];
  });
  const extras = Object.entries(stats).flatMap(([key, value]) => {
    if (known.has(key) || value === 0 || value === "") return [];
    return [`${typeof value === "number" ? formatCount(value) : value} ${key}`];
  });
  const funnel = stages.join(theme.fg("dim", ` ${GLYPH.arrow} `));
  const line = joinParts([funnel ? theme.fg("muted", funnel) : undefined, ...extras.map((extra) => theme.fg("muted", extra))], theme);
  return line ? [line] : [];
}

function renderGenericResult(frame: ResultFrame): string[] {
  const { view, expanded, theme } = frame;
  const width = innerWidth(frame);
  const summary = workflowResultSummary(view.result);
  const legacyBackground = view.background === true;
  const agents = agentCount(view);
  const facts = [theme.fg("success", "done"), agents > 0 ? theme.fg("muted", plural(agents, "agent")) : undefined];
  const lines = [headerLine(theme.fg("success", GLYPH.done), frame, facts)];

  const json = resultJson(view.result, summary !== undefined);
  let more = json !== undefined;
  if (summary) {
    const style = (line: string) => theme.fg("text", line);
    lines.push(...indent(paragraph(summary, width, style, expanded ? undefined : COLLAPSED_GENERIC_LINES)));
    more ||= clips(summary, width, COLLAPSED_GENERIC_LINES);
  } else if (!expanded) {
    lines.push(...indent([theme.fg("dim", resultShape(view.result))]));
  }
  if (expanded && json !== undefined) {
    if (summary) lines.push("");
    lines.push(...indent(jsonLines(json, width, theme)));
  }
  if (expanded) {
    const rows = runDetailRows(frame, { agents: false });
    if (rows.length > 0) lines.push("", ...rows);
  }

  const pairs: HintPair[] = legacyBackground ? [["/workflow:runs", "run history"]] : [];
  const footer = footerLine(frame, pairs, { more: more || Boolean(view.runId) });
  if (footer) lines.push(footer);
  return lines;
}

/** The result as pretty JSON, minus the summary already shown above it; undefined when nothing is left. */
function resultJson(result: unknown, summaryShown: boolean): string | undefined {
  if (typeof result === "string") return undefined;
  if (!summaryShown || !isRecord(result)) return prettyJson(result);
  const rest = Object.entries(result).filter(([key]) => key !== "summary");
  return rest.length > 0 ? prettyJson(Object.fromEntries(rest)) : undefined;
}

/** What a summary-less result holds: `result · areas, risks, notes` or `result · 12 items`. */
function resultShape(result: unknown): string {
  if (result === undefined || result === null) return "no result";
  if (Array.isArray(result)) return `result · ${plural(result.length, "item")}`;
  if (isRecord(result)) {
    const keys = Object.keys(result);
    return keys.length === 0 ? "empty result" : `result · ${keys.join(", ")}`;
  }
  return `result · ${String(result)}`;
}

/** Pretty JSON, each long line wrapped under its own indentation. */
function jsonLines(json: string, width: number, theme: Theme): string[] {
  return json.split("\n").flatMap((line) => {
    const depth = line.length - line.trimStart().length;
    const lead = " ".repeat(depth);
    return paragraph(line.trimStart(), Math.max(8, width - depth - 2), (part) => part).map((part, index) =>
      theme.fg("dim", `${index === 0 ? lead : `${lead}  `}${part}`));
  });
}

type InterruptedState = "failed" | "stopped" | "paused";

function isInterruptedState(status: unknown): status is InterruptedState {
  return status === "failed" || status === "stopped" || status === "paused";
}

/** A background run that ended without a result: what happened, and where to resume it. */
function renderInterruptedRun(frame: ResultFrame, status: InterruptedState): string[] {
  const { view, expanded, theme } = frame;
  const color = status === "failed" ? "error" : "warning";
  const glyph = theme.fg(color, status === "failed" ? GLYPH.failed : GLYPH.warning);
  const lines = [headerLine(glyph, frame, [theme.fg(color, status)])];
  const summary = workflowResultSummary(view.result);
  if (summary) {
    lines.push(...indent(paragraph(summary, innerWidth(frame), (line) => theme.fg("muted", line), expanded ? undefined : COLLAPSED_GENERIC_LINES)));
  }
  if (expanded) {
    const rows = runDetailRows(frame);
    if (rows.length > 0) lines.push("", ...rows);
  }
  const footer = footerLine(frame, [["/workflow:runs", status === "failed" ? "resume or restart" : "resume"]], {
    more: Boolean(view.runId) || (summary !== undefined && clips(summary, innerWidth(frame), COLLAPSED_GENERIC_LINES)),
  });
  if (footer) lines.push(footer);
  return lines;
}
