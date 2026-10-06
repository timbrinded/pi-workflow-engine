import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { isAdvisoryReport, type AdvisoryReportWithStats } from "../advisory-schema.ts";
import { isRecord } from "../guards.ts";
import { renderIssueDetails, renderIssuesTable } from "../review/review-format.ts";
import { toReviewIssues } from "../review/review-issues.ts";
import { formatCount } from "../text.ts";
import { formatPerfSummary } from "../perf.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import { workflowResultSummary, type WorkflowPerfDetails, type WorkflowResultEnvelope } from "../workflow-execution.ts";
import { unknownErrorMessage } from "../unknown-error.ts";

export function isWorkflowResult(value: unknown): value is WorkflowResultEnvelope {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && "result" in value && typeof value.completedAt === "number";
}

/** What the result renderers read. Persisted message details are unvalidated, so `usage` stays `unknown`. */
export interface WorkflowResultView {
  readonly name: string;
  readonly result: unknown;
  readonly usage?: unknown;
  readonly perf?: WorkflowPerfDetails;
  readonly runId?: string;
  readonly resumedFromRunId?: string;
}

type WorkflowDetailLineInput = Pick<WorkflowResultView, "usage" | "perf" | "runId" | "resumedFromRunId">;

export function renderWorkflowResult(view: WorkflowResultView, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderWorkflowResultText(view, expanded, theme), 0, 0));
  return box;
}

export function renderWorkflowResultText(view: WorkflowResultView, expanded: boolean, theme: Theme): string {
  if (isAdvisoryReport(view.result)) return renderAdvisoryResult(view, view.result, expanded, theme);
  return renderGenericWorkflowResult(view, expanded, theme);
}

function renderAdvisoryResult(view: WorkflowResultView, result: AdvisoryReportWithStats, expanded: boolean, theme: Theme): string {
  const incomplete = result.status === "incomplete";
  const icon = incomplete ? theme.fg("warning", "⚠") : theme.fg("success", "✓");
  const title = theme.fg("accent", theme.bold(`Workflow: ${view.name}`));
  const lines = [`${icon} ${title}`, theme.fg("muted", result.summary)];
  if (result.coverage?.length) lines.push(theme.fg("dim", result.coverage.map((stage) => `${stage.stage}: ${stage.completed}/${stage.expected} complete, ${stage.failed} failed`).join(" · ")));
  if (expanded) for (const gap of result.gaps ?? []) lines.push(theme.fg("warning", gap));
  const stats = statsLine(result.stats, theme);
  if (stats) lines.push(stats);
  pushWorkflowDetailLines(lines, theme, view);

  if (result.findings.length === 0) {
    lines.push(incomplete ? theme.fg("warning", "No verified findings; coverage is incomplete.") : theme.fg("success", "No findings."));
    if (expanded && result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
    return lines.join("\n");
  }

  const issues = toReviewIssues(result);
  lines.push(theme.fg("dim", "Findings:"));
  lines.push(renderIssuesTable(issues, theme, { maxRows: expanded ? issues.length : 12 }));
  if (expanded) {
    for (const issue of issues) {
      lines.push(renderIssueDetails(issue, theme));
    }
  }
  if (expanded && result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
  return lines.join("\n");
}

function renderNextSteps(nextSteps: string[], lines: string[], theme: Theme): void {
  lines.push(theme.fg("dim", "Next steps:"));
  for (const step of nextSteps) {
    lines.push(`  - ${theme.fg("muted", step)}`);
  }
}

function renderGenericWorkflowResult(view: WorkflowResultView, expanded: boolean, theme: Theme): string {
  const lines = [`${theme.fg("success", "✓")} ${theme.fg("accent", theme.bold(`Workflow: ${view.name}`))}`];
  const summary = workflowResultSummary(view.result);
  if (summary) lines.push(theme.fg("muted", summary));
  pushWorkflowDetailLines(lines, theme, view);
  if (expanded) lines.push(theme.fg("dim", safeJson(view.result)));
  else if (!summary) lines.push(theme.fg("dim", "Result available in expanded view."));
  return lines.join("\n");
}

function pushWorkflowDetailLines(lines: string[], theme: Theme, input: WorkflowDetailLineInput): void {
  for (const line of formatWorkflowDetailLines(input)) {
    lines.push(theme.fg("dim", line));
  }
}

export function formatWorkflowDetailLines(input: WorkflowDetailLineInput): string[] {
  return [
    formatWorkflowRunLine(input),
    formatWorkflowUsageLine(input.usage),
    input.perf ? formatPerfSummary(input.perf.aggregates) : undefined,
  ].filter((line): line is string => line !== undefined);
}

function formatWorkflowRunLine({ runId, resumedFromRunId }: WorkflowDetailLineInput): string | undefined {
  if (!runId) return undefined;
  return resumedFromRunId ? `Run: ${runId} (resumed from ${resumedFromRunId})` : `Run: ${runId}`;
}

function statsLine(stats: Record<string, string | number> | undefined, theme: Theme): string | undefined {
  if (!stats) return undefined;
  const ordered = ["files", "candidates", "dropped", "verified", "kept"];
  const parts = ordered.flatMap((key) => {
    const value = stats[key];
    if (value === undefined) return [];
    return [`${key} ${typeof value === "number" ? formatCount(value) : value}`];
  });
  if (parts.length === 0) return undefined;
  return theme.fg("dim", parts.join(" · "));
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return unknownErrorMessage(error);
  }
}
