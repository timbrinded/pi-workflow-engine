import { truncateText } from "./text.ts";
import { formatWorkflowUsageLine } from "./usage.ts";
import type { WorkflowRunRecord } from "./workflow-run-record.ts";
import { formatDuration } from "./ui/workflow-format.ts";

export const WORKFLOW_RUN_HISTORY_LIMIT = 50;
export const WORKFLOW_RUN_DETAIL_AGENT_LIMIT = 100;
export const WORKFLOW_RUN_OUTCOME_TEXT_LIMIT = 16_000;

export const WORKFLOW_RUN_ACTIONS = [
  { value: "inspect", description: "Show a retained workflow run" },
  { value: "stop", description: "Stop an active or paused workflow run" },
  { value: "resume", description: "Resume a paused workflow run" },
  { value: "restart", description: "Restart a terminal workflow run" },
] as const;

export type WorkflowRunLifecycleAction = typeof WORKFLOW_RUN_ACTIONS[number]["value"];

const WORKFLOW_RUN_ACTION_VALUES: ReadonlySet<string> = new Set(
  WORKFLOW_RUN_ACTIONS.map((action) => action.value),
);

export type WorkflowRunsCommand =
  | { readonly kind: "list" }
  | { readonly kind: "action"; readonly action: WorkflowRunLifecycleAction; readonly runId: string }
  | { readonly kind: "error"; readonly message: string };

export function parseWorkflowRunsCommand(input: string): WorkflowRunsCommand {
  const parts = input.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { kind: "list" };
  const action = parts[0];
  if (!action || !isWorkflowRunLifecycleAction(action)) {
    return { kind: "error", message: workflowRunsUsage() };
  }
  if (parts.length !== 2 || !parts[1]) return { kind: "error", message: workflowRunsUsage() };
  return { kind: "action", action, runId: parts[1] };
}

export function isWorkflowRunLifecycleAction(value: string): value is WorkflowRunLifecycleAction {
  return WORKFLOW_RUN_ACTION_VALUES.has(value);
}

export function workflowRunsUsage(): string {
  return `Usage: /workflow:runs [${WORKFLOW_RUN_ACTIONS.map((action) => action.value).join("|")} <run-id>]`;
}

/** What a run's lifecycle actions depend on beyond its own record. */
export interface WorkflowRunActionContext {
  /** Runs this session is executing in the background. */
  readonly activeRunIds: ReadonlySet<string>;
  /** Resumed runs, keyed to the run that resumed them; see {@link supersedingRuns}. */
  readonly resumedAs: ReadonlyMap<string, string>;
}

/**
 * Maps each run to a stored run that resumed it and is queued, running, paused or completed, so
 * resuming it again would replay its journal a second time. A run whose every resume failed or
 * was stopped is absent, which leaves manual resume as the way back to its journal.
 */
export function supersedingRuns(records: readonly WorkflowRunRecord[]): ReadonlyMap<string, string> {
  const resumedAs = new Map<string, string>();
  for (const record of records) {
    const source = record.options.resumeFromRunId;
    if (source !== undefined && record.state !== "failed" && record.state !== "stopped") resumedAs.set(source, record.runId);
  }
  return resumedAs;
}

export function availableWorkflowRunActions(
  record: WorkflowRunRecord,
  runs: WorkflowRunActionContext,
): readonly WorkflowRunLifecycleAction[] {
  const actions: WorkflowRunLifecycleAction[] = ["inspect"];
  if ((record.state === "queued" || record.state === "running") && runs.activeRunIds.has(record.runId)) actions.push("stop");
  if (record.state === "paused") {
    actions.push("stop");
    if (!runs.resumedAs.has(record.runId) && canRelaunchWorkflowRun(record)) actions.push("resume");
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
  runs: WorkflowRunActionContext,
  now = Date.now(),
): string {
  if (records.length === 0) return "No durable workflow runs are available for this project.";
  const lines = ["Recent workflow runs:"];
  for (const record of records) {
    lines.push(`- ${formatWorkflowRunSummary(record, runs, now)}`);
  }
  return lines.join("\n");
}

export function formatWorkflowRunSummary(
  record: WorkflowRunRecord,
  runs: WorkflowRunActionContext,
  now = Date.now(),
): string {
  const usage = formatWorkflowUsageLine(record.usage);
  const resumedAs = runs.resumedAs.get(record.runId);
  const actions = availableWorkflowRunActions(record, runs).filter((action) => action !== "inspect");
  return `${record.state.toUpperCase()} ${record.workflow.name} · age ${formatDuration(Math.max(0, now - record.createdAt))} · duration ${formatWorkflowRunDuration(record, now)}${usage ? ` · ${usage}` : ""} · ${record.runId}${resumedAs ? ` · resumed as ${resumedAs}` : ""}${actions.length > 0 ? ` · actions ${actions.join(", ")}` : ""}`;
}

export function formatWorkflowRunDetails(
  record: WorkflowRunRecord,
  runs: WorkflowRunActionContext,
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
    `State: ${record.state.toUpperCase()}`,
    `Age: ${formatDuration(Math.max(0, now - record.createdAt))}`,
    `Duration: ${formatWorkflowRunDuration(record, now)}`,
    `Phase: ${record.progress.currentPhase}`,
    `Actions: ${availableWorkflowRunActions(record, runs).join(", ")}`,
  ];
  const resumedAs = runs.resumedAs.get(record.runId);
  if (resumedAs) lines.push(`Resumed as: ${resumedAs}`);
  if (usage) lines.push(usage);
  if (record.options.resumeEditedWorkflow) lines.push("Edited-workflow resume: enabled");
  const cachedAgents = record.progress.counters.find((counter) => counter.key === "resume.cached")?.value ?? 0;
  const liveAgents = record.progress.counters.find((counter) => counter.key === "resume.live")?.value ?? 0;
  if (cachedAgents > 0 || liveAgents > 0) lines.push(`Resume calls: ${cachedAgents} cached, ${liveAgents} live`);
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
    if (record.result.kind === "unavailable") return truncateText(`Result unavailable: ${record.result.reason}`, WORKFLOW_RUN_OUTCOME_TEXT_LIMIT);
    return truncateText(JSON.stringify(record.result.value, null, 2), WORKFLOW_RUN_OUTCOME_TEXT_LIMIT);
  }
  if (record.state === "failed" || record.state === "stopped" || record.state === "paused") {
    return truncateText(record.message, WORKFLOW_RUN_OUTCOME_TEXT_LIMIT);
  }
  return "Run is still in progress.";
}

export function formatWorkflowRunDuration(record: WorkflowRunRecord, now = Date.now()): string {
  const start = record.startedAt ?? record.createdAt;
  const end = record.endedAt ?? (record.state === "paused" ? record.updatedAt : now);
  return formatDuration(Math.max(0, end - start));
}
