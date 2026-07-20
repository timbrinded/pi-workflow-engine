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
  parseWorkflowRunsCommand,
  retainedWorkflowRunOutcome,
  WORKFLOW_RUN_HISTORY_LIMIT,
  type WorkflowRunLifecycleAction,
} from "./workflow-run-history.ts";
import { transitionWorkflowRun, type WorkflowRunRecord } from "./workflow-run-record.ts";
import { ProjectWorkflowRunStore, type WorkflowRunStore } from "./workflow-run-store.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { emptyWorkflowUsageTotals } from "./usage.ts";
import {
  WorkflowUsageLimitScheduler,
  type WorkflowUsageLimitSchedulerClock,
} from "./workflow-usage-limit-scheduler.ts";
import { WorkflowInspector } from "./ui/workflow-inspector.ts";
import { completeCurrentArgument, splitArgumentPrefix } from "./command-completions.ts";

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
  private completionContext: ExtensionContext | undefined;

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
    this.completionContext = ctx;
    this.usageLimitScheduler.activateSession(ctx);
    try {
      for (const record of await this.storeForCwd(ctx.cwd).list()) {
        if (canRelaunchWorkflowRun(record)) this.usageLimitScheduler.arm(ctx, record);
      }
    } catch (error) {
      this.log(`[workflow] provider-limit recovery could not load run history: ${unknownErrorMessage(error)}`);
    }
  }

  sessionShutdown(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.usageLimitScheduler.cancelSession(ctx);
    if (this.completionContext?.sessionManager.getSessionId() === ctx.sessionManager.getSessionId()) {
      this.completionContext = undefined;
    }
  }

  async handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    this.completionContext = ctx;
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
      const records = await this.listRecent(ctx.cwd);
      ctx.ui.notify(formatWorkflowRunHistory(records, this.background.activeRunIds(ctx)), "info");
      return;
    }
    await this.openRunSelector(ctx);
  }

  async inspectStoredRun(ctx: ExtensionContext, runId: string): Promise<boolean> {
    this.completionContext = ctx;
    const record = await this.loadRecord(ctx.cwd, runId);
    if (!record) return false;
    await this.inspect(record, ctx);
    return true;
  }

  private async openRunSelector(ctx: ExtensionCommandContext): Promise<void> {
    while (true) {
      const records = await this.listRecent(ctx.cwd);
      const active = this.background.activeRunIds(ctx);
      if (records.length === 0) {
        ctx.ui.notify(formatWorkflowRunHistory(records, active), "info");
        return;
      }
      const options = records.map((record) =>
        formatWorkflowRunSummary(record, active.has(record.runId))
      );
      const selected = await ctx.ui.select("Workflow Runs", options);
      if (!selected) return;
      const selectedIndex = options.indexOf(selected);
      const selectedRecord = records[selectedIndex];
      const record = selectedRecord && await this.loadRecord(ctx.cwd, selectedRecord.runId);
      if (!record) {
        ctx.ui.notify("The selected workflow run is no longer available.", "warning");
        continue;
      }
      const actions = availableWorkflowRunActions(record, active.has(record.runId));
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
      ctx.ui.notify(
        formatWorkflowRunDetails(record, this.background.activeRunIds(ctx).has(record.runId)),
        "info",
      );
      return;
    }
    await ctx.ui.custom<void>(
      (tui, theme, _keybindings, done) => new WorkflowInspector(
        () => record.progress,
        tui,
        theme,
        () => done(undefined),
        { label: `${record.state.toUpperCase()} outcome`, text: retainedWorkflowRunOutcome(record) },
      ),
      { overlay: true, overlayOptions: { anchor: "right-center", width: "70%", maxHeight: "80%", margin: 1 } },
    );
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
    const available = availableWorkflowRunActions(
      record,
      this.background.activeRunIds(ctx).has(record.runId),
    );
    if (!available.includes(action)) {
      ctx.ui.notify(`Action ${action} is not available for ${record.state} run ${runId}.`, "warning");
      return;
    }

    try {
      if (action === "stop") {
        if (record.state === "paused") {
          this.usageLimitScheduler.cancel(runId);
          const stopped = transitionWorkflowRun(record, {
            state: "stopped",
            progress: record.progress,
            usage: record.usage ?? record.progress.usage ?? {
              agents: [],
              totals: emptyWorkflowUsageTotals(),
              assistantMessages: 0,
            },
            error: new Error("Workflow stopped by user."),
          });
          await this.storeForCwd(ctx.cwd).save(stopped);
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
    if (unavailable) {
      const first = unavailable.content[0];
      throw new Error(first?.type === "text" ? first.text : "background workflows are unavailable");
    }
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
      inspect: false,
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
      resultViewer: "skip",
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
    const first = result.content[0];
    const message = first?.type === "text" ? first.text : `Workflow ${action} started.`;
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

  private async listRecent(cwd: string): Promise<WorkflowRunRecord[]> {
    const records = await this.storeForCwd(cwd).list();
    return records
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, WORKFLOW_RUN_HISTORY_LIMIT);
  }

  async argumentCompletions(argumentPrefix: string): Promise<AutocompleteItem[] | null> {
    const ctx = this.completionContext;
    const parts = splitArgumentPrefix(argumentPrefix);
    if (parts.completed.length === 0) {
      return completeCurrentArgument(argumentPrefix, [
        { value: "inspect", description: "Show a retained workflow run" },
        { value: "stop", description: "Stop an active or paused workflow run" },
        { value: "resume", description: "Resume a paused workflow run" },
        { value: "restart", description: "Restart a terminal workflow run" },
      ]);
    }
    if (parts.completed.length !== 1) return null;
    const action = parts.completed[0];
    if (action !== "inspect" && action !== "stop" && action !== "resume" && action !== "restart") return null;
    const records = await this.listRecent(ctx?.cwd ?? process.cwd());
    const active = ctx === undefined ? new Set<string>() : this.background.activeRunIds(ctx);
    return completeCurrentArgument(
      argumentPrefix,
      records
        .filter((record) => availableWorkflowRunActions(record, active.has(record.runId)).includes(action))
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
    const records = await this.listRecent(ctx?.cwd ?? process.cwd());
    return completeCurrentArgument(argumentPrefix, [
      { value: "last", description: "Inspect the current or most recent in-session workflow" },
      ...records.map((record) => ({
        value: record.runId,
        description: `${record.state} · ${record.workflow.name}`,
      })),
    ]);
  }
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
