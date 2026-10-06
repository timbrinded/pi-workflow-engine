import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { WorkflowProgressEvent } from "./types.ts";
import type { AgentRowStatus, WorkflowLaneItemStatus, WorkflowProgressSnapshot } from "./progress-types.ts";
import type { WorkflowUsageSnapshot } from "./usage.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { statusTextFromCounts, type WorkflowStatusCounts } from "./ui/workflow-format.ts";
import { renderWorkflowWidget, STRING_WIDGET_WIDTH, WidthAwareWidget } from "./ui/workflow-widget.ts";

interface AgentRow {
  id: number;
  label: string;
  status: AgentRowStatus;
  startedAt?: number;
  doneAt?: number;
  toolUses: number;
  lastTool?: string;
  error?: string;
}

interface Phase {
  title: string;
  agents: AgentRow[];
}

interface WorkflowCounter {
  key: string;
  label: string;
  value: number;
}

interface WorkflowLaneItem {
  lane: string;
  title: string;
  subtitle?: string;
  status: WorkflowLaneItemStatus;
  details?: string;
  createdAt: number;
}

const LOG_LIMIT = 24;
const WIDGET_REFRESH_INTERVAL_MS = 1_000;
export const DEFAULT_LANE_ITEM_LIMIT = 200;

export interface ProgressTrackerOptions {
  /** Phase titles from the workflow's `meta.phases`, shown as upcoming until the run reaches them. */
  readonly plannedPhases?: readonly string[];
}

/**
 * Tracks live workflow state for widgets, footer/status text, result renderers,
 * and headless stderr breadcrumbs.
 */
export class ProgressTracker {
  private readonly phases: Phase[] = [];
  private readonly logs: string[] = [];
  private readonly counters = new Map<string, WorkflowCounter>();
  private readonly summary = new Map<string, string | number>();
  private readonly lanes = new Map<string, WorkflowLaneItem[]>();
  private readonly laneOverflow = new Map<string, number>();
  private readonly rowsById = new Map<number, AgentRow>();
  private readonly agentCounts: Record<AgentRowStatus, number> = { queued: 0, running: 0, done: 0, failed: 0 };
  private readonly startedAt = Date.now();
  private readonly laneItemLimit = laneItemLimitFromEnv();
  private doneAt: number | undefined;
  private currentPhase = "Workflow";
  private nextAgentId = 1;
  private lastStatusText: string | undefined;
  private usageSnapshot: WorkflowUsageSnapshot | undefined;
  private widgetRefreshInterval: ReturnType<typeof setInterval> | undefined;
  private readonly surfaceKey: string;
  private readonly plannedPhases: readonly string[] | undefined;
  /** Latest published snapshot; the TUI widget renders it at whatever width the terminal has. */
  private latest: WorkflowProgressSnapshot | undefined;
  /** Set once the TUI has instantiated this run's widget component. */
  private tui: Pick<TUI, "requestRender"> | undefined;
  private widgetRegistered = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly title: string,
    private readonly runId: string,
    private readonly onSnapshot?: (snapshot: WorkflowProgressSnapshot) => void,
    options: ProgressTrackerOptions = {},
  ) {
    this.surfaceKey = `workflow:${runId}`;
    this.plannedPhases = options.plannedPhases?.length ? [...options.plannedPhases] : undefined;
    this.ensurePhase(this.currentPhase);
  }

  private ensurePhase(title: string): Phase {
    let phase = this.phases.find((candidate) => candidate.title === title);
    if (!phase) {
      phase = { title, agents: [] };
      this.phases.push(phase);
    }
    return phase;
  }

  phase(title: string): void {
    this.currentPhase = title;
    this.ensurePhase(title);
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${title}\n`);
    this.publish();
  }

  log(message: string): void {
    this.logs.push(message);
    while (this.logs.length > LOG_LIMIT) this.logs.shift();
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${message}\n`);
    this.publish();
  }

  event(event: WorkflowProgressEvent): void {
    switch (event.type) {
      case "counter":
        this.counters.set(event.key, { key: event.key, label: event.label, value: event.value });
        break;
      case "counter_delta": {
        const current = this.counters.get(event.key);
        this.counters.set(event.key, {
          key: event.key,
          label: event.label,
          value: (current?.value ?? 0) + event.delta,
        });
        break;
      }
      case "lane_item": {
        const lane = this.lanes.get(event.lane) ?? [];
        lane.push({
          lane: event.lane,
          title: event.title,
          subtitle: event.subtitle,
          status: event.status,
          details: event.details,
          createdAt: Date.now(),
        });
        this.pruneLane(event.lane, lane);
        this.lanes.set(event.lane, lane);
        break;
      }
      case "summary":
        this.summary.set(event.key, event.value);
        break;
    }
    this.publish();
  }

  agentQueued(phase: string | undefined, label: string): number {
    const id = this.nextAgentId++;
    const row = { label, id, status: "queued" as const, toolUses: 0 };
    this.ensurePhase(phase ?? this.currentPhase).agents.push(row);
    this.rowsById.set(id, row);
    this.agentCounts.queued++;
    this.publish();
    return id;
  }

  agentStart(id: number): void {
    const row = this.rowsById.get(id);
    if (row) {
      this.transitionAgentStatus(row, "running");
      row.startedAt = Date.now();
      row.error = undefined;
    }
    this.publish();
  }

  agentTool(id: number, tool: string): void {
    const row = this.rowsById.get(id);
    if (row) {
      row.lastTool = tool;
      row.toolUses += 1;
    }
    this.publish();
  }

  agentDone(id: number): void {
    const row = this.rowsById.get(id);
    if (row && row.status !== "failed") {
      this.transitionAgentStatus(row, "done");
      row.doneAt = Date.now();
    }
    this.publish();
  }

  agentFailed(id: number, error: unknown): void {
    const row = this.rowsById.get(id);
    if (row) {
      this.transitionAgentStatus(row, "failed");
      row.doneAt = Date.now();
      row.error = unknownErrorMessage(error);
    }
    this.publish();
  }

  updateUsage(snapshot: WorkflowUsageSnapshot): void {
    this.usageSnapshot = snapshot;
    this.publish();
  }

  snapshot(): WorkflowProgressSnapshot {
    return {
      runId: this.runId,
      title: this.title,
      startedAt: this.startedAt,
      doneAt: this.doneAt,
      currentPhase: this.currentPhase,
      plannedPhases: this.plannedPhases,
      phases: this.phases.map((phase) => ({
        title: phase.title,
        agents: phase.agents.map((agent) => ({ ...agent })),
      })),
      counters: [...this.counters.values()].map((counter) => ({ ...counter })),
      summary: [...this.summary.entries()],
      lanes: [...this.lanes.entries()].map(([lane, items]) => [lane, items.map((item) => ({ ...item }))]),
      laneOverflow: [...this.laneOverflow.entries()],
      logs: [...this.logs],
      usage: this.usageSnapshot,
    };
  }

  statusCounts(): WorkflowStatusCounts {
    return {
      queued: this.agentCounts.queued,
      running: this.agentCounts.running,
      done: this.agentCounts.done,
      failed: this.agentCounts.failed,
      total: this.agentCounts.queued + this.agentCounts.running + this.agentCounts.done + this.agentCounts.failed,
    };
  }

  private transitionAgentStatus(row: AgentRow, nextStatus: AgentRowStatus): void {
    if (row.status === nextStatus) return;
    this.agentCounts[row.status]--;
    row.status = nextStatus;
    this.agentCounts[nextStatus]++;
  }

  private pruneLane(laneName: string, lane: WorkflowLaneItem[]): void {
    while (lane.length > this.laneItemLimit) {
      lane.shift();
      this.laneOverflow.set(laneName, (this.laneOverflow.get(laneName) ?? 0) + 1);
    }
  }

  private publish(): void {
    const snapshot = this.snapshot();
    this.onSnapshot?.(snapshot);
    // Agents that outlive a fatal drain still report after done(); record them without reviving live surfaces.
    if (!this.ctx.hasUI || this.doneAt !== undefined) return;
    this.latest = snapshot;
    this.publishWidget(snapshot);
    this.startWidgetRefresh();
    this.publishStatus(snapshot);
  }

  /**
   * In the TUI the widget is a width-aware component registered once and redrawn on demand; surfaces
   * that only take strings (RPC) get lines pre-rendered at a nominal width on every publish.
   */
  private publishWidget(snapshot: WorkflowProgressSnapshot): void {
    if (this.ctx.mode !== "tui") {
      this.ctx.ui.setWidget(this.surfaceKey, renderWorkflowWidget(snapshot, STRING_WIDGET_WIDTH, this.ctx.ui.theme), { placement: "aboveEditor" });
      return;
    }
    if (this.widgetRegistered) {
      this.tui?.requestRender();
      return;
    }
    this.widgetRegistered = true;
    this.ctx.ui.setWidget(
      this.surfaceKey,
      (tui, theme) => {
        this.tui = tui;
        return new WidthAwareWidget((width) => (this.latest ? renderWorkflowWidget(this.latest, width, theme) : []));
      },
      { placement: "aboveEditor" },
    );
  }

  /** Elapsed time ticks even when no agent reports, so redraw the widget and status once a second. */
  private startWidgetRefresh(): void {
    if (this.widgetRefreshInterval !== undefined) return;
    this.widgetRefreshInterval = setInterval(() => {
      if (!this.latest) return;
      this.publishWidget(this.latest);
      this.publishStatus(this.latest);
    }, WIDGET_REFRESH_INTERVAL_MS);
  }

  private stopWidgetRefresh(): void {
    if (this.widgetRefreshInterval === undefined) return;
    clearInterval(this.widgetRefreshInterval);
    this.widgetRefreshInterval = undefined;
  }

  private publishStatus(snapshot: WorkflowProgressSnapshot): void {
    const next = statusTextFromCounts(snapshot, this.statusCounts(), this.ctx.ui.theme);
    if (next === this.lastStatusText) return;
    this.ctx.ui.setStatus(this.surfaceKey, next);
    this.lastStatusText = next;
  }

  /** Clear this run's live workflow surfaces. Final feedback is delivered by the result surface. */
  done(): void {
    this.doneAt = Date.now();
    this.stopWidgetRefresh();
    this.onSnapshot?.(this.snapshot());
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget(this.surfaceKey, undefined);
    this.ctx.ui.setStatus(this.surfaceKey, undefined);
    this.lastStatusText = undefined;
    this.latest = undefined;
    this.tui = undefined;
  }
}

function laneItemLimitFromEnv(): number {
  const parsed = Number(process.env.PI_WORKFLOW_LANE_ITEM_LIMIT ?? "");
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LANE_ITEM_LIMIT;
  return Math.trunc(parsed);
}
