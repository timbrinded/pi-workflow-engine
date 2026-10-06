import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { BackgroundWorkflowCoordinator } from "./background-workflows.ts";
import { backgroundUnavailableResult, startBackgroundWorkflowTool } from "./background-workflow-tool.ts";
import { validateWorkflowRunId } from "./journal.ts";
import { resolveWorkflowRunOptions, type ResolvedWorkflowRunOptions } from "./options.ts";
import type { LoadedWorkflow } from "./types.ts";
import {
  availableWorkflowRunActions,
  canRelaunchWorkflowRun,
  formatWorkflowRunDetails,
  formatWorkflowRunHistory,
  formatWorkflowRunSummary,
  isWorkflowRunLifecycleAction,
  parseWorkflowRunsCommand,
  retainedWorkflowRunOutcome,
  supersedingRuns,
  WORKFLOW_RUN_ACTIONS,
  WORKFLOW_RUN_HISTORY_LIMIT,
  type WorkflowRunActionContext,
  type WorkflowRunLifecycleAction,
} from "./workflow-run-history.ts";
import { stopWorkflowRunRecord, type WorkflowRunRecord } from "./workflow-run-record.ts";
import { ProjectWorkflowRunStore, type WorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import {
  WorkflowUsageLimitScheduler,
  type WorkflowUsageLimitSchedulerClock,
} from "./workflow-usage-limit-scheduler.ts";
import { showWorkflowInspector } from "./ui/workflow-inspector.ts";
import { WorkflowRunsBrowser, type WorkflowRunsBrowserChoice } from "./ui/workflow-runs-browser.ts";
import { WORKFLOW_VIEWER_OVERLAY_OPTIONS } from "./ui/workflow-viewer-layout.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";

type WorkflowRunCompletionContext = Pick<ExtensionContext, "cwd" | "sessionManager">;

interface WorkflowRunControllerDependencies {
  readonly resolveWorkflow: (name: string) => Promise<LoadedWorkflow | undefined>;
  readonly execute: (
    ctx: ExtensionContext,
    name: string,
    workflow: LoadedWorkflow,
    options: ResolvedWorkflowRunOptions,
  ) => Promise<void>;
  readonly storeForCwd?: (cwd: string) => WorkflowRunStore;
  readonly schedulerClock?: WorkflowUsageLimitSchedulerClock;
  readonly log?: (message: string) => void;
}

export class WorkflowRunController {
  private readonly storeForCwd: (cwd: string) => WorkflowRunStore;
  private readonly usageLimitScheduler: WorkflowUsageLimitScheduler;
  private readonly log: (message: string) => void;
  private completionContext: WorkflowRunCompletionContext | undefined;

  constructor(
    private readonly background: BackgroundWorkflowCoordinator,
    private readonly dependencies: WorkflowRunControllerDependencies,
  ) {
    this.storeForCwd = dependencies.storeForCwd ?? ((cwd) => new ProjectWorkflowRunStore(cwd));
    this.log = dependencies.log ?? ((message) => process.stderr.write(`${message}\n`));
    this.usageLimitScheduler = new WorkflowUsageLimitScheduler(
      (ctx, runId, attempt) => this.autoResume(ctx, runId, attempt),
      dependencies.schedulerClock,
      dependencies.log,
    );
  }

  async runSettled(ctx: ExtensionContext, runId: string): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (record && canRelaunchWorkflowRun(record)) this.usageLimitScheduler.arm(ctx, record);
  }

  async sessionStarted(ctx: ExtensionContext): Promise<void> {
    this.completionContext = { cwd: ctx.cwd, sessionManager: ctx.sessionManager };
    this.usageLimitScheduler.activateSession(ctx);
    try {
      const records = await this.storeForCwd(ctx.cwd).list();
      const resumed = resumedRunIds(records);
      for (const record of records) {
        if (!resumed.has(record.runId) && canRelaunchWorkflowRun(record)) this.usageLimitScheduler.arm(ctx, record);
      }
    } catch (error) {
      this.log(`[workflow] provider-limit recovery could not load run history: ${unknownErrorMessage(error)}`);
    }
  }

  sessionShutdown(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.usageLimitScheduler.cancelSession(ctx);
    this.completionContext = undefined;
  }

  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const command = parseWorkflowRunsCommand(args);
    if (command.kind === "error") {
      ctx.ui.notify(command.message, "warning");
      return;
    }
    if (command.kind === "action") {
      await this.perform(command.action, command.runId, ctx);
      return;
    }
    if (!ctx.hasUI) {
      const { records, runs } = await this.history(ctx);
      ctx.ui.notify(formatWorkflowRunHistory(records, runs), "info");
      return;
    }
    if (ctx.mode === "tui") await this.openRunsBrowser(ctx);
    else await this.openRunSelector(ctx);
  }

  async inspectStoredRun(ctx: ExtensionContext, runId: string): Promise<boolean> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) return false;
    await this.inspect(record, ctx);
    return true;
  }

  /** The TUI runs overlay; it reopens on the same run after each action until closed. */
  private async openRunsBrowser(ctx: ExtensionCommandContext): Promise<void> {
    let initialRunId: string | undefined;
    while (true) {
      const { records, runs } = await this.history(ctx);
      if (records.length === 0) {
        ctx.ui.notify(formatWorkflowRunHistory(records, runs), "info");
        return;
      }
      const choice = await ctx.ui.custom<WorkflowRunsBrowserChoice | undefined>(
        (...[tui, theme, , done]) =>
          new WorkflowRunsBrowser({ records, runs }, tui, theme, done, { initialRunId, refresh: () => this.history(ctx) }),
        WORKFLOW_VIEWER_OVERLAY_OPTIONS,
      );
      if (!choice) return;
      initialRunId = choice.runId;
      await this.perform(choice.action, choice.runId, ctx);
    }
  }

  /** Two native selects (run, then action) for UI hosts that cannot show custom components, such as RPC. */
  private async openRunSelector(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const { records, runs } = await this.history(ctx);
      if (records.length === 0) {
        ctx.ui.notify(formatWorkflowRunHistory(records, runs), "info");
        return;
      }
      const options = records.map((record) => formatWorkflowRunSummary(record, runs));
      const selected = await ctx.ui.select("Workflow Runs", options);
      if (!selected) return;
      const selectedIndex = options.indexOf(selected);
      const selectedRecord = records[selectedIndex];
      const record = selectedRecord && await this.loadRecord(ctx.cwd, selectedRecord.runId);
      if (!record) {
        ctx.ui.notify("The selected workflow run is no longer available.", "warning");
        continue;
      }
      const actions = availableWorkflowRunActions(record, runs);
      const selectedAction = await ctx.ui.select(
        `${record.workflow.name} · ${record.runId}`,
        [...actions],
      );
      const action = actions.find((candidate) => candidate === selectedAction);
      if (!action) continue;
      if (action === "inspect") await this.inspect(record, ctx);
      else await this.perform(action, record.runId, ctx);
    }
  }

  private async inspect(record: WorkflowRunRecord, ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI || ctx.mode !== "tui") {
      ctx.ui.notify(formatWorkflowRunDetails(record, (await this.history(ctx)).runs), "info");
      return;
    }
    await showWorkflowInspector(ctx.ui, () => record.progress, { text: retainedWorkflowRunOutcome(record), state: record.state });
  }

  private async perform(
    action: WorkflowRunLifecycleAction,
    runId: string,
    ctx: ExtensionContext,
  ): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) {
      ctx.ui.notify(`Workflow run ${runId} was not found.`, "warning");
      return;
    }
    if (action === "inspect") {
      await this.inspect(record, ctx);
      return;
    }
    const { runs } = await this.history(ctx);
    if (!availableWorkflowRunActions(record, runs).includes(action)) {
      const resumedAs = record.state === "paused" && action === "resume" ? runs.resumedAs.get(runId) : undefined;
      ctx.ui.notify(
        resumedAs
          ? `Workflow run ${runId} was already resumed as ${resumedAs}.`
          : `Action ${action} is not available for ${record.state} run ${runId}.`,
        "warning",
      );
      return;
    }

    try {
      if (action === "stop") {
        if (record.state === "paused") {
          this.usageLimitScheduler.cancel(runId);
          await this.storeForCwd(ctx.cwd).save(stopWorkflowRunRecord(record));
          await this.background.durableRunSettled(ctx, runId);
          ctx.ui.notify(`Workflow run ${runId} is now stopped.`, "info");
          return;
        }
        const stopped = await this.background.stop(ctx, runId);
        ctx.ui.notify(`Workflow run ${runId} is now ${stopped.state}.`, "info");
        return;
      }
      this.usageLimitScheduler.cancel(runId);
      const message = await this.relaunch(ctx, record, action);
      ctx.ui.notify(message, "info");
    } catch (error) {
      ctx.ui.notify(`Workflow ${action} failed: ${unknownErrorMessage(error)}`, "error");
    }
  }

  private async relaunch(
    ctx: ExtensionContext,
    record: WorkflowRunRecord,
    action: "resume" | "restart",
  ): Promise<string> {
    const unavailable = backgroundUnavailableResult(ctx.mode);
    if (unavailable) throw new Error(unavailable.content[0].text);
    const workflow = await this.dependencies.resolveWorkflow(record.workflow.name);
    if (!workflow) throw new Error(`registered workflow ${record.workflow.name} is unavailable`);
    if (workflow.source.kind !== "file") {
      throw new Error(`registered workflow ${record.workflow.name} no longer has verifiable file provenance`);
    }
    if (
      action === "resume"
      && workflow.source.fingerprint !== record.workflow.sourceFingerprint
    ) {
      throw new Error("workflow source changed, so journal replay cannot resume safely");
    }
    const options = resolveWorkflowRunOptions({
      perf: record.options.perf,
      concurrency: record.options.concurrency,
      parallelSubmissionLimit: record.options.parallelSubmissionLimit ?? undefined,
      maxAgents: record.options.maxAgents,
      agentTimeoutMs: record.options.agentTimeoutMs,
      agentRetries: record.options.agentRetries,
      autoResumeOnUsageLimit: record.options.autoResumeOnUsageLimit,
      usageLimitMaxAttempts: record.options.usageLimitMaxAttempts,
      usageLimitMaxDelayMs: record.options.usageLimitMaxDelayMs,
      usageLimitAttempt: action === "resume"
        ? (record.state === "paused" ? record.pause?.attempt : undefined) ?? record.options.usageLimitAttempt
        : 0,
      budget: record.options.budget ?? undefined,
      resumeFromRunId: action === "resume" ? record.runId : undefined,
    });
    const result = await startBackgroundWorkflowTool({
      coordinator: this.background,
      ctx,
      name: workflow.meta.name,
      options,
      execute: (backgroundCtx, backgroundOptions) =>
        this.dependencies.execute(backgroundCtx, workflow.meta.name, workflow, backgroundOptions),
    });
    const message = result.content[0].text;
    if (typeof result.details.error === "string") throw new Error(message);
    return message;
  }

  private async autoResume(ctx: ExtensionContext, runId: string, attempt: number): Promise<void> {
    const record = await this.loadRecord(ctx.cwd, runId);
    if (
      record?.state !== "paused"
      || record.pause?.kind !== "provider_usage_limit"
      || !record.pause.autoResume
      || record.pause.attempt !== attempt
      || !canRelaunchWorkflowRun(record)
      || resumedRunIds(await this.storeForCwd(ctx.cwd).list()).has(runId)
    ) {
      return;
    }
    const message = await this.relaunch(ctx, record, "resume");
    ctx.ui.notify(message, "info");
  }

  private async loadRecord(cwd: string, runId: string): Promise<WorkflowRunRecord | undefined> {
    try {
      validateWorkflowRunId(runId);
    } catch {
      return undefined;
    }
    return await this.storeForCwd(cwd).load(runId);
  }

  /** The most recent runs and what their actions depend on, from one store listing. */
  private async history(
    ctx: WorkflowRunCompletionContext,
  ): Promise<{ readonly records: WorkflowRunRecord[]; readonly runs: WorkflowRunActionContext }> {
    const records = await this.storeForCwd(ctx.cwd).list();
    return {
      records: [...records]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, WORKFLOW_RUN_HISTORY_LIMIT),
      runs: { activeRunIds: this.background.activeRunIds(ctx), resumedAs: supersedingRuns(records) },
    };
  }

  async argumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
    const ctx = this.completionContext;
    const parts = splitArgumentPrefix(argumentPrefix);
    if (parts.completed.length === 0) {
      return completeCurrentArgument(argumentPrefix, WORKFLOW_RUN_ACTIONS);
    }
    if (parts.completed.length !== 1 || !ctx) return null;
    const action = parts.completed[0];
    if (!action || !isWorkflowRunLifecycleAction(action)) return null;
    const { records, runs } = await this.history(ctx);
    return completeCurrentArgument(
      argumentPrefix,
      records
        .filter((record) => availableWorkflowRunActions(record, runs).includes(action))
        .map((record) => ({
          value: record.runId,
          description: `${record.state} · ${record.workflow.name}`,
        })),
    );
  }

  async inspectorArgumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
    const ctx = this.completionContext;
    const parts = splitArgumentPrefix(argumentPrefix);
    if (parts.completed.length > 0) return null;
    const records = ctx ? (await this.history(ctx)).records : [];
    return completeCurrentArgument(argumentPrefix, [
      { value: "last", description: "Inspect the current or most recent in-session workflow" },
      ...records.map((record) => ({
        value: record.runId,
        description: `${record.state} · ${record.workflow.name}`,
      })),
    ]);
  }
}

/**
 * Runs that any stored run resumed, whatever that resume's outcome. A resumed run keeps its paused
 * record and pause attempt, so automatic resume treats the pause as spent: re-arming it after a
 * failed or stopped resume would relaunch it on every session start. Manual resume instead uses
 * `supersedingRuns`, which frees a run whose every resume failed or was stopped.
 */
function resumedRunIds(records: readonly WorkflowRunRecord[]): ReadonlySet<string> {
  return new Set(records.flatMap((record) => record.options.resumeFromRunId ?? []));
}

export function registerWorkflowRunCommand(
  pi: Pick<ExtensionAPI, "registerCommand">,
  controller: WorkflowRunController,
): void {
  pi.registerCommand("workflow:runs", {
    description: "List, inspect, stop, resume, or restart durable workflow runs",
    getArgumentCompletions: (argumentPrefix) => controller.argumentCompletions(argumentPrefix),
    handler: (args, ctx) => controller.handleCommand(args, ctx),
  });
}
