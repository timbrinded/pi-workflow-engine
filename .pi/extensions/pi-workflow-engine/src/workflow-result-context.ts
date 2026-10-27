import { join } from "node:path";
import { formatAdvisoryLocation, isAdvisoryReport, type AdvisoryFinding, type AdvisoryReport } from "./advisory-schema.ts";
import { isRecord } from "./guards.ts";
import { WORKFLOW_RUNS_DIR } from "./journal.ts";
import { workflowRunScriptFile } from "./workflow-run-record.ts";
import { WORKFLOW_RUN_RECORD_SUFFIX } from "./workflow-run-store.ts";
import { toReviewIssues } from "./review/review-issues.ts";
import { formatPerfSummary } from "./perf.ts";
import { prettyJson } from "./text.ts";
import { formatWorkflowUsageLine } from "./usage.ts";
import { workflowResultSummary, type WorkflowResultEnvelope } from "./workflow-execution.ts";

/** Cap on the result JSON copied into the host agent's context; the run record keeps the full value. */
const MAX_CONTEXT_RESULT_JSON_CHARS = 20_000;

/** The host model only sees this text, never the envelope `details`, so it carries every result field. */
export function formatWorkflowResultForContext(envelope: WorkflowResultEnvelope): string {
  const details = formatWorkflowDetailLines(envelope);
  return `## Workflow: ${envelope.name}\n\n${formatResultForContext(envelope.result)}${details.length > 0 ? `\n\n${details.join("\n")}` : ""}`;
}

/** Run id, run files, usage and perf lines appended for the host model. */
function formatWorkflowDetailLines(envelope: WorkflowResultEnvelope): string[] {
  return [
    ...(envelope.runId
      ? [formatWorkflowRunLine({ runId: envelope.runId, resumedFromRunId: envelope.resumedFromRunId }), ...formatWorkflowRunFileLines(envelope.runId, envelope.scriptPersisted === true)]
      : []),
    formatWorkflowUsageLine(envelope.usage),
    envelope.perf ? formatPerfSummary(envelope.perf.aggregates) : undefined,
  ].filter((line): line is string => line !== undefined);
}

/** The run id, naming the run a resume continues. */
export function formatWorkflowRunLine(run: { readonly runId: string; readonly resumedFromRunId?: string }): string {
  return run.resumedFromRunId ? `Run: ${run.runId} (resumed from ${run.resumedFromRunId})` : `Run: ${run.runId}`;
}

/**
 * Where the host model can read what the run did, relative to the workflow cwd: the record holding the full
 * result, the persisted script it can edit and rerun with `scriptPath`, and the replay journal of completed
 * agent results.
 */
export function formatWorkflowRunFileLines(runId: string, scriptPersisted: boolean): string[] {
  return [
    `Record: ${join(WORKFLOW_RUNS_DIR, `${runId}${WORKFLOW_RUN_RECORD_SUFFIX}`)}`,
    ...(scriptPersisted ? [`Script: ${join(WORKFLOW_RUNS_DIR, workflowRunScriptFile(runId))}`] : []),
    `Journal: ${join(WORKFLOW_RUNS_DIR, `${runId}.jsonl`)}`,
    "If the result is empty or unexpected, read the journal before diagnosing.",
  ];
}

/** A workflow result as the host model reads it: advisory reports as findings, other values as bounded JSON. */
export function formatResultForContext(result: unknown): string {
  if (typeof result === "string") return result;
  if (isAdvisoryReport(result)) return formatAdvisoryReportForContext(result);
  const summary = workflowResultSummary(result);
  if (summary !== undefined && isRecord(result) && Object.keys(result).length === 1) return summary;
  const json = formatResultJson(result);
  if (json === undefined) return summary ?? "Workflow finished.";
  return summary === undefined ? json : `${summary}\n\n${json}`;
}

function formatAdvisoryReportForContext(report: AdvisoryReport): string {
  const lines = [report.summary];
  const issues = toReviewIssues(report);
  if (issues.length > 0) {
    lines.push("", "Findings:");
    for (const { id, finding } of issues) {
      lines.push(
        `\n### ${id}: ${finding.summary}`,
        `- Severity: ${finding.severity}`,
        `- Confidence: ${finding.confidence}`,
        `- Category: ${finding.category}`,
        `- Location: ${formatFindingLocations(finding)}`,
        `- Impact: ${finding.impact}`,
        `- Evidence: ${finding.evidence.length > 0 ? finding.evidence.join("; ") : "(none cited)"}`,
        `- Recommendation: ${finding.recommendation}`,
      );
    }
  }
  if (report.gaps && report.gaps.length > 0) {
    lines.push("", "Coverage gaps:", ...report.gaps.map((gap) => `- ${gap}`));
  }
  if (report.nextSteps.length > 0) {
    lines.push("", "Next steps:", ...report.nextSteps.map((step) => `- ${step}`));
  }
  return lines.join("\n");
}

function formatResultJson(result: unknown): string | undefined {
  if (result === null || result === undefined) return undefined;
  const json = prettyJson(result);
  if (json === undefined) return undefined;
  if (json.length <= MAX_CONTEXT_RESULT_JSON_CHARS) return `Result:\n\`\`\`json\n${json}\n\`\`\``;
  return `Result (first ${MAX_CONTEXT_RESULT_JSON_CHARS} of ${json.length} characters; truncated, the run record holds the full value):\n\`\`\`json\n${json.slice(0, MAX_CONTEXT_RESULT_JSON_CHARS)}\n\`\`\``;
}

/** The review anchor that the findings viewer and PR comments cite comes first, then every other cited location. */
function formatFindingLocations(finding: AdvisoryFinding): string {
  const locations = finding.reviewAnchor ? [finding.reviewAnchor, ...finding.locations] : finding.locations;
  return [...new Set(locations.map(formatAdvisoryLocation))].join(", ");
}
