import { formatAdvisoryLocation, isAdvisoryReport, type AdvisoryFinding, type AdvisoryReport } from "./advisory-schema.ts";
import { isRecord } from "./guards.ts";
import { toReviewIssues } from "./review/review-issues.ts";
import { prettyJson } from "./text.ts";
import { formatWorkflowDetailLines } from "./ui/workflow-result-renderer.ts";
import { workflowResultSummary, type WorkflowResultEnvelope } from "./workflow-execution.ts";

/** Cap on the result JSON copied into the host agent's context; the run record keeps the full value. */
const MAX_CONTEXT_RESULT_JSON_CHARS = 20_000;

/** The host model only sees this text, never the envelope `details`, so it carries every result field. */
export function formatWorkflowResultForContext(envelope: WorkflowResultEnvelope): string {
  const details = formatWorkflowDetailLines(envelope);
  return `## Workflow: ${envelope.name}\n\n${formatResultForContext(envelope.result)}${details.length > 0 ? `\n\n${details.join("\n")}` : ""}`;
}

function formatResultForContext(result: unknown): string {
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
