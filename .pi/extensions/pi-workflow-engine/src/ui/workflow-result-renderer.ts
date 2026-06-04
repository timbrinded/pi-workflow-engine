import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, type Component, Text } from "@earendil-works/pi-tui";
import type { AdvisoryFinding, AdvisoryLocation, AdvisoryReport } from "../advisory-schema.ts";
import { badge, formatCount, type WorkflowThemeColor } from "./workflow-format.ts";

export interface WorkflowResultEnvelope {
  name: string;
  result: unknown;
  completedAt: number;
}

export interface AdvisoryWorkflowResult extends AdvisoryReport {
  stats?: Record<string, string | number>;
}

export function isWorkflowResult(value: unknown): value is WorkflowResultEnvelope {
  if (!isRecord(value)) return false;
  return typeof value.name === "string" && "result" in value && typeof value.completedAt === "number";
}

function isAdvisoryLocation(value: unknown): value is AdvisoryLocation {
  if (!isRecord(value)) return false;
  if (typeof value.file !== "string") return false;
  if (value.line !== undefined && typeof value.line !== "number") return false;
  if (value.symbol !== undefined && typeof value.symbol !== "string") return false;
  return true;
}

function isAdvisoryFinding(value: unknown): value is AdvisoryFinding {
  if (!isRecord(value)) return false;
  if (typeof value.summary !== "string") return false;
  if (typeof value.category !== "string") return false;
  if (!isSeverity(value.severity)) return false;
  if (!isConfidence(value.confidence)) return false;
  if (!Array.isArray(value.locations) || !value.locations.every(isAdvisoryLocation)) return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((entry) => typeof entry === "string")) return false;
  if (typeof value.impact !== "string") return false;
  if (typeof value.recommendation !== "string") return false;
  return true;
}

export function isAdvisoryReport(value: unknown): value is AdvisoryWorkflowResult {
  if (!isRecord(value)) return false;
  if (typeof value.summary !== "string" || !Array.isArray(value.findings)) return false;
  if (!value.findings.every(isAdvisoryFinding)) return false;
  if (!Array.isArray(value.nextSteps) || !value.nextSteps.every((entry) => typeof entry === "string")) return false;
  if (value.stats !== undefined && !isStats(value.stats)) return false;
  return true;
}

export function renderWorkflowResult(name: string, result: unknown, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderWorkflowResultText(name, result, expanded, theme), 0, 0));
  return box;
}

export function renderWorkflowResultText(name: string, result: unknown, expanded: boolean, theme: Theme): string {
  if (isAdvisoryReport(result)) {
    return renderAdvisoryResult(name, result, expanded, theme);
  }
  return renderGenericWorkflowResult(name, result, expanded, theme);
}

function renderAdvisoryResult(name: string, result: AdvisoryWorkflowResult, expanded: boolean, theme: Theme): string {
  const icon = theme.fg("success", "✓");
  const title = theme.fg("accent", theme.bold(`Workflow: ${name}`));
  const lines = [`${icon} ${title}`, theme.fg("muted", result.summary)];
  const stats = statsLine(result.stats, theme);
  if (stats) lines.push(stats);

  if (result.findings.length === 0) {
    lines.push(theme.fg("success", "No findings."));
    if (expanded && result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
    return lines.join("\n");
  }

  const findings = expanded ? result.findings : result.findings.slice(0, 3);
  lines.push(theme.fg("dim", expanded ? "Findings:" : "Top findings:"));
  for (const finding of findings) {
    lines.push(renderAdvisoryFinding(finding, expanded, theme));
  }
  if (!expanded && result.findings.length > findings.length) {
    lines.push(theme.fg("dim", `… ${result.findings.length - findings.length} more finding(s)`));
  }
  if (expanded && result.nextSteps.length > 0) renderNextSteps(result.nextSteps, lines, theme);
  return lines.join("\n");
}

function renderAdvisoryFinding(finding: AdvisoryFinding, expanded: boolean, theme: Theme): string {
  const location = formatLocation(finding.locations[0]);
  let text =
    `  ${badge(finding.category, "accent", theme)} ` +
    `${badge(finding.severity, severityColor(finding.severity), theme)} ` +
    `${badge(`${finding.confidence} confidence`, confidenceColor(finding.confidence), theme)} ` +
    `${theme.fg("accent", location)} ${theme.fg("muted", finding.summary)}`;
  if (expanded) {
    text += `\n    ${theme.fg("dim", `Impact: ${finding.impact}`)}`;
    text += `\n    ${theme.fg("dim", `Evidence: ${finding.evidence.join("; ") || "(none cited)"}`)}`;
    text += `\n    ${theme.fg("dim", `Recommendation: ${finding.recommendation}`)}`;
  }
  return text;
}

function renderNextSteps(nextSteps: string[], lines: string[], theme: Theme): void {
  lines.push(theme.fg("dim", "Next steps:"));
  for (const step of nextSteps) {
    lines.push(`  - ${theme.fg("muted", step)}`);
  }
}

function formatLocation(location: AdvisoryLocation | undefined): string {
  if (!location) return "(no location)";
  const line = location.line != null ? `:${location.line}` : "";
  const symbol = location.symbol ? ` (${location.symbol})` : "";
  return `${location.file}${line}${symbol}`;
}

function severityColor(severity: AdvisoryFinding["severity"]): WorkflowThemeColor {
  switch (severity) {
    case "high":
      return "error";
    case "medium":
      return "warning";
    case "low":
      return "muted";
  }
}

function confidenceColor(confidence: AdvisoryFinding["confidence"]): WorkflowThemeColor {
  switch (confidence) {
    case "high":
      return "success";
    case "medium":
      return "warning";
    case "low":
      return "muted";
  }
}

function renderGenericWorkflowResult(name: string, result: unknown, expanded: boolean, theme: Theme): string {
  const lines = [`${theme.fg("success", "✓")} ${theme.fg("accent", theme.bold(`Workflow: ${name}`))}`];
  const summary = extractSummary(result);
  if (summary) lines.push(theme.fg("muted", summary));
  if (expanded) lines.push(theme.fg("dim", safeJson(result)));
  else if (!summary) lines.push(theme.fg("dim", "Result available in expanded view."));
  return lines.join("\n");
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
    return error instanceof Error ? error.message : String(error);
  }
}

function isSeverity(value: unknown): value is AdvisoryFinding["severity"] {
  return value === "low" || value === "medium" || value === "high";
}

function isConfidence(value: unknown): value is AdvisoryFinding["confidence"] {
  return value === "low" || value === "medium" || value === "high";
}

function isStats(value: unknown): value is Record<string, string | number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string" || typeof entry === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
