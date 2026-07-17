import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { WorkflowProgressEvent } from "./types.ts";
import type { AgentRowStatus, WorkflowLaneItemStatus, WorkflowProgressSnapshot } from "./progress-types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { statusTextFromCounts, type WorkflowStatusCounts } from "./ui/workflow-format.ts";
import { createWorkflowWidget, type WorkflowWidget } from "./ui/workflow-widget.ts";

export type {
  AgentRowSnapshot,
  AgentRowStatus,
  PhaseSnapshot,
  WorkflowCounterSnapshot,
  WorkflowLaneItemSnapshot,
  WorkflowLaneItemStatus,
  WorkflowProgressSnapshot,
} from "./progress-types.ts";

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
export const DEFAULT_LANE_ITEM_LIMIT = 200;

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
  private widget: WorkflowWidget | undefined;
  private widgetRegistered = false;
  private tui: Pick<TUI, "requestRender"> | undefined;
  private widgetInterval: ReturnType<typeof setInterval> | undefined;
  private lastStatusText: string | undefined;
  private renderQueued = false;

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly title: string,
  ) {
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
    this.render();
  }

  log(message: string): void {
    this.logs.push(message);
    while (this.logs.length > LOG_LIMIT) this.logs.shift();
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${message}\n`);
    this.render();
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
    this.render();
  }

  agentQueued(phase: string | undefined, label: string): number {
    const id = this.nextAgentId++;
    const row = { label, id, status: "queued" as const, toolUses: 0 };
    this.ensurePhase(phase ?? this.currentPhase).agents.push(row);
    this.rowsById.set(id, row);
    this.agentCounts.queued++;
    this.render();
    return id;
  }

  agentStart(phase: string | undefined, label: string, id?: number): void {
    const row = id === undefined ? undefined : this.findRowById(id);
    if (row) {
      this.transitionAgentStatus(row, "running");
      row.startedAt = Date.now();
      row.error = undefined;
    } else {
      const nextRow = {
        label,
        id: this.nextAgentId++,
        status: "running" as const,
        startedAt: Date.now(),
        toolUses: 0,
      };
      this.ensurePhase(phase ?? this.currentPhase).agents.push(nextRow);
      this.rowsById.set(nextRow.id, nextRow);
      this.agentCounts.running++;
    }
    this.render();
  }

  agentTool(label: string, tool: string, id?: number): void {
    const row = this.findRow(label, id);
    if (row) {
      row.lastTool = tool;
      row.toolUses += 1;
    }
    this.render();
  }

  agentDone(label: string, id?: number): void {
    const row = this.findRow(label, id);
    if (row && row.status !== "failed") {
      this.transitionAgentStatus(row, "done");
      row.doneAt = Date.now();
    }
    this.render();
  }

  agentFailed(label: string, error: unknown, id?: number): void {
    const row = this.findRow(label, id);
    if (row) {
      this.transitionAgentStatus(row, "failed");
      row.doneAt = Date.now();
      row.error = unknownErrorMessage(error);
    }
    this.render();
  }

  snapshot(): WorkflowProgressSnapshot {
    return {
      title: this.title,
      startedAt: this.startedAt,
      doneAt: this.doneAt,
      currentPhase: this.currentPhase,
      phases: this.phases.map((phase) => ({
        title: phase.title,
        agents: phase.agents.map((agent) => ({ ...agent })),
      })),
      counters: [...this.counters.values()].map((counter) => ({ ...counter })),
      summary: [...this.summary.entries()],
      lanes: [...this.lanes.entries()].map(([lane, items]) => [lane, items.map((item) => ({ ...item }))]),
      laneOverflow: [...this.laneOverflow.entries()],
      logs: [...this.logs],
    };
  }

  statusCounts(): WorkflowStatusCounts {
    return this.statusCountsSnapshot();
  }

  private statusCountsSnapshot(): WorkflowStatusCounts {
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
    if (this.laneItemLimit <= 0) return;
    while (lane.length > this.laneItemLimit) {
      lane.shift();
      this.laneOverflow.set(laneName, (this.laneOverflow.get(laneName) ?? 0) + 1);
    }
  }

  private findRow(label: string, id?: number): AgentRow | undefined {
    if (id !== undefined) return this.findRowById(id);
    for (let i = this.phases.length - 1; i >= 0; i--) {
      const running = this.phases[i].agents.find(
        (agent) => agent.label === label && (agent.status === "running" || agent.status === "queued"),
      );
      if (running) return running;
    }
    for (let i = this.phases.length - 1; i >= 0; i--) {
      const matching = this.phases[i].agents.find((agent) => agent.label === label);
      if (matching) return matching;
    }
    return undefined;
  }

  private findRowById(id: number): AgentRow | undefined {
    return this.rowsById.get(id);
  }

  private render(): void {
    if (!this.ctx.hasUI) return;
    this.ensureWidget();
    this.widget?.invalidate();
    this.requestRenderSoon();
    this.publishStatus();
  }

  private requestRenderSoon(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    queueMicrotask(() => {
      this.renderQueued = false;
      this.tui?.requestRender();
    });
  }

  private publishStatus(): void {
    const next = statusTextFromCounts(
      {
        title: this.title,
        doneAt: this.doneAt,
        currentPhase: this.currentPhase,
        counters: [...this.counters.values()].map((counter) => ({ ...counter })),
      },
      this.statusCountsSnapshot(),
      this.ctx.ui.theme,
    );
    if (next === this.lastStatusText) return;
    this.ctx.ui.setStatus("workflow", next);
    this.lastStatusText = next;
  }

  private ensureWidget(): void {
    if (this.widgetRegistered) return;
    this.widget = createWorkflowWidget(() => this.snapshot());
    this.ctx.ui.setWidget(
      "workflow",
      (tui, theme) => {
        this.tui = tui;
        return {
          render: (width?: number) => this.widget?.render(width ?? tui.terminal.columns, theme) ?? [],
          invalidate: () => this.widget?.invalidate(),
        };
      },
      { placement: "aboveEditor" },
    );
    this.widgetRegistered = true;
    this.startWidgetTimer();
  }

  private startWidgetTimer(): void {
    if (this.widgetInterval !== undefined) return;
    this.widgetInterval = setInterval(() => {
      this.widget?.nextFrame();
      this.tui?.requestRender();
    }, 100);
  }

  private stopWidgetTimer(): void {
    if (this.widgetInterval === undefined) return;
    clearInterval(this.widgetInterval);
    this.widgetInterval = undefined;
  }

  /** Clear live workflow surfaces; optionally leave a one-line final status. */
  done(status?: string): void {
    this.doneAt = Date.now();
    this.stopWidgetTimer();
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget("workflow", undefined);
    this.ctx.ui.setStatus("workflow", status);
    this.lastStatusText = status;
    this.renderQueued = false;
    this.widgetRegistered = false;
    this.widget = undefined;
    this.tui = undefined;
  }
}

function laneItemLimitFromEnv(): number {
  const parsed = Number(process.env.PI_WORKFLOW_LANE_ITEM_LIMIT ?? "");
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LANE_ITEM_LIMIT;
  return Math.trunc(parsed);
}
