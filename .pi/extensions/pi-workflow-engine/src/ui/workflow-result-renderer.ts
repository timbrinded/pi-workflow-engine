import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import { isAdvisoryReport, type AdvisoryReportWithStats } from "../advisory-schema.ts";
import { renderIssueDetails, renderIssuesTable } from "../review/review-format.ts";
import { toReviewIssues } from "../review/review-issues.ts";
import { formatCount } from "./workflow-format.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import type { WorkflowPerfDetails, WorkflowResultEnvelope } from "../workflow-execution.ts";
import { unknownErrorMessage } from "../unknown-error.ts";

export function isWorkflowResult(value: unknown): value is WorkflowResultEnvelope {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && "result" in value && typeof value.completedAt === "number";
}

export interface WorkflowRunDisplayMetadata {
  readonly runId?: string;
  readonly resumedFromRunId?: string;
}

export interface WorkflowDetailLineInput {
  readonly usage?: unknown;
  readonly perf?: WorkflowPerfDetails;
  readonly metadata?: WorkflowRunDisplayMetadata;
}

export function renderWorkflowResult(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderWorkflowResultText(name, result, expanded, theme, usage, metadata, perf), 0, 0));
  return box;
}

export function renderWorkflowResultText(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  if (isAdvisoryReport(result)) {
    return renderAdvisoryResult(name, result, expanded, theme, usage, metadata, perf);
  }
  return renderGenericWorkflowResult(name, result, expanded, theme, usage, metadata, perf);
}

function renderAdvisoryResult(
  name: string,
  result: AdvisoryReportWithStats,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  const icon = theme.fg("success", "✓");
  const title = theme.fg("accent", theme.bold(`Workflow: ${name}`));
  const lines = [`${icon} ${title}`, theme.fg("muted", result.summary)];
  const stats = statsLine(result.stats, theme);
  if (stats) lines.push(stats);
  pushWorkflowDetailLines(lines, theme, { usage, metadata, perf });

  if (result.findings.length === 0) {
    lines.push(theme.fg("success", "No findings."));
    if (expanded && result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
    return lines.join("\n");
  }

  const issues = toReviewIssues(name, result);
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

function renderGenericWorkflowResult(
  name: string,
  result: unknown,
  expanded: boolean,
  theme: Theme,
  usage?: unknown,
  metadata?: WorkflowRunDisplayMetadata,
  perf?: WorkflowPerfDetails,
): string {
  const lines = [`${theme.fg("success", "✓")} ${theme.fg("accent", theme.bold(`Workflow: ${name}`))}`];
  const summary = extractSummary(result);
  if (summary) lines.push(theme.fg("muted", summary));
  pushWorkflowDetailLines(lines, theme, { usage, metadata, perf });
  if (expanded) lines.push(theme.fg("dim", safeJson(result)));
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
    formatWorkflowRunLine(input.metadata),
    formatWorkflowUsageLine(input.usage),
    formatWorkflowPerfLine(input.perf),
  ].filter((line): line is string => line !== undefined);
}

export function formatWorkflowRunLine(metadata: WorkflowRunDisplayMetadata | undefined): string | undefined {
  if (!metadata?.runId) return undefined;
  return metadata.resumedFromRunId ? `Run: ${metadata.runId} (resumed from ${metadata.resumedFromRunId})` : `Run: ${metadata.runId}`;
}

export function formatWorkflowPerfLine(perf: WorkflowPerfDetails | undefined): string | undefined {
  if (!perf) return undefined;
  const parts = perf.aggregates.slice(0, 4).map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `Perf: ${parts.join(" · ")}` : "Perf: no samples";
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

function extractSummary(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.summary === "string") return value.summary;
  return undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return unknownErrorMessage(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
