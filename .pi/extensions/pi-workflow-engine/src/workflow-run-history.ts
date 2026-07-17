import { formatWorkflowUsageLine } from "./usage.ts";
import type { WorkflowRunRecord, WorkflowRunState } from "./workflow-run-record.ts";
import { formatDuration } from "./ui/workflow-format.ts";

export const WORKFLOW_RUN_HISTORY_LIMIT = 50;
export const WORKFLOW_RUN_DETAIL_AGENT_LIMIT = 100;
export const WORKFLOW_RUN_OUTCOME_TEXT_LIMIT = 16_000;

export type WorkflowRunLifecycleAction = "inspect" | "stop" | "resume" | "restart";

export type WorkflowRunsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "action"; readonly action: WorkflowRunLifecycleAction; readonly runId: string }
  | { readonly kind: "error"; readonly message: string };

export function parseWorkflowRunsCommand(input: string): WorkflowRunsCommand {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "list" };
  const action = parts[0];
  if (action !== "inspect" && action !== "stop" && action !== "resume" && action !== "restart") {
    return { kind: "error", message: workflowRunsUsage() };
  }
  if (parts.length !== 2 || !parts[1]) return { kind: "error", message: workflowRunsUsage() };
  return { kind: "action", action, runId: parts[1] };
}

export function workflowRunsUsage(): string {
  return "Usage: /workflow:runs [inspect|stop|resume|restart <run-id>]";
}

export function availableWorkflowRunActions(
  record: WorkflowRunRecord,
  active: boolean,
): readonly WorkflowRunLifecycleAction[] {
  const actions: WorkflowRunLifecycleAction[] = ["inspect"];
  if ((record.state === "queued" || record.state === "running") && active) actions.push("stop");
  if (record.state === "paused") {
    actions.push("stop");
    if (canRelaunchWorkflowRun(record)) actions.push("resume");
  }
  if (
    (record.state === "completed" || record.state === "failed" || record.state === "stopped")
    && canRelaunchWorkflowRun(record)
  ) {
    actions.push("restart");
  }
  return actions;
}

export function canRelaunchWorkflowRun(record: WorkflowRunRecord): boolean {
  return record.workflow.sourceKind === "file"
    && typeof record.workflow.sourceFingerprint === "string"
    && record.options.argumentsPresent === false;
}

export function formatWorkflowRunHistory(
  records: readonly WorkflowRunRecord[],
  activeRunIds: ReadonlySet<string> = new Set(),
  now = Date.now(),
): string {
  if (records.length === 0) return "No durable workflow runs are available for this project.";
  const lines = ["Recent workflow runs:"];
  for (const record of records.slice(0, WORKFLOW_RUN_HISTORY_LIMIT)) {
    const usage = formatWorkflowUsageLine(record.usage);
    const active = activeRunIds.has(record.runId);
    const actions = availableWorkflowRunActions(record, active).filter((action) => action !== "inspect");
    lines.push(
      `- ${workflowRunStateLabel(record.state)} ${record.workflow.name} · age ${formatDuration(Math.max(0, now - record.createdAt))} · duration ${formatWorkflowRunDuration(record, now)}${usage ? ` · ${usage}` : ""} · ${record.runId}${actions.length > 0 ? ` · actions ${actions.join(", ")}` : ""}`,
    );
  }
  if (records.length > WORKFLOW_RUN_HISTORY_LIMIT) {
    lines.push(`… ${records.length - WORKFLOW_RUN_HISTORY_LIMIT} older runs hidden`);
  }
  return lines.join("\n");
}

export function formatWorkflowRunDetails(
  record: WorkflowRunRecord,
  active: boolean,
  now = Date.now(),
): string {
  const agents = record.progress.phases.flatMap((phase) =>
    phase.agents.map((agent) => `${phase.title} / ${agent.label}: ${agent.status}`)
  );
  const shownAgents = agents.slice(0, WORKFLOW_RUN_DETAIL_AGENT_LIMIT);
  const usage = formatWorkflowUsageLine(record.usage);
  const lines = [
    `Workflow run ${record.runId}`,
    `Workflow: ${record.workflow.name}`,
    `State: ${workflowRunStateLabel(record.state)}`,
    `Age: ${formatDuration(Math.max(0, now - record.createdAt))}`,
    `Duration: ${formatWorkflowRunDuration(record, now)}`,
    `Phase: ${record.progress.currentPhase}`,
    `Actions: ${availableWorkflowRunActions(record, active).join(", ")}`,
  ];
  if (usage) lines.push(usage);
  if (record.state === "paused" && record.pause?.kind === "provider_usage_limit") {
    lines.push(
      `Provider limit attempt: ${record.pause.attempt}/${record.pause.maxAttempts}`,
      `Next eligible: ${new Date(record.pause.nextEligibleAt).toISOString()}`,
      `Automatic resume: ${record.pause.autoResume ? "scheduled" : "disabled"}`,
      `Provider message: ${record.pause.providerMessage}`,
    );
  }
  if (shownAgents.length > 0) {
    lines.push("Agents:", ...shownAgents.map((agent) => `- ${agent}`));
    if (agents.length > shownAgents.length) lines.push(`… ${agents.length - shownAgents.length} agents hidden`);
  }
  lines.push("Outcome:", retainedWorkflowRunOutcome(record));
  return lines.join("\n");
}

export function retainedWorkflowRunOutcome(record: WorkflowRunRecord): string {
  if (record.state === "completed") {
    if (record.result.kind === "unavailable") return boundedOutcome(`Result unavailable: ${record.result.reason}`);
    return boundedOutcome(JSON.stringify(record.result.value, null, 2));
  }
  if (record.state === "failed" || record.state === "stopped" || record.state === "paused") {
    return boundedOutcome(record.message);
  }
  return "Run is still in progress.";
}

export function formatWorkflowRunDuration(record: WorkflowRunRecord, now = Date.now()): string {
  const start = record.startedAt ?? record.createdAt;
  const end = record.endedAt ?? (record.state === "paused" ? record.updatedAt : now);
  return formatDuration(Math.max(0, end - start));
}

export function workflowRunStateLabel(state: WorkflowRunState): string {
  return state.toUpperCase();
}

function boundedOutcome(value: string): string {
  return value.length <= WORKFLOW_RUN_OUTCOME_TEXT_LIMIT
    ? value
    : `${value.slice(0, WORKFLOW_RUN_OUTCOME_TEXT_LIMIT - 1)}…`;
}
