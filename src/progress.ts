import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowLaneItemStatus, WorkflowProgressEvent } from "./types.ts";

export type AgentRowStatus = "queued" | "running" | "done" | "failed";

export interface AgentRowSnapshot {
  readonly id: number;
  readonly label: string;
  readonly status: AgentRowStatus;
  readonly startedAt?: number;
  readonly doneAt?: number;
  readonly toolUses: number;
  readonly lastTool?: string;
  readonly error?: string;
}

export interface PhaseSnapshot {
  readonly title: string;
  readonly agents: readonly AgentRowSnapshot[];
}

export interface WorkflowCounterSnapshot {
  readonly key: string;
  readonly label: string;
  readonly value: number;
}

export interface WorkflowLaneItemSnapshot {
  readonly lane: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly status: WorkflowLaneItemStatus;
  readonly details?: string;
  readonly createdAt: number;
}

export interface WorkflowProgressSnapshot {
  readonly title: string;
  readonly startedAt: number;
  readonly doneAt?: number;
  readonly currentPhase: string;
  readonly phases: readonly PhaseSnapshot[];
  readonly counters: readonly WorkflowCounterSnapshot[];
  readonly summary: readonly [string, string | number][];
  readonly lanes: readonly [string, readonly WorkflowLaneItemSnapshot[]][];
  readonly logs: readonly string[];
}

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
  private readonly startedAt = Date.now();
  private doneAt: number | undefined;
  private currentPhase = "Workflow";
  private nextAgentId = 1;

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
    this.ensurePhase(phase ?? this.currentPhase).agents.push({ label, id, status: "queued", toolUses: 0 });
    this.render();
    return id;
  }

  agentStart(phase: string | undefined, label: string, id?: number): void {
    const row = id === undefined ? undefined : this.findRowById(id);
    if (row) {
      row.status = "running";
      row.startedAt = Date.now();
      row.error = undefined;
    } else {
      this.ensurePhase(phase ?? this.currentPhase).agents.push({
        label,
        id: this.nextAgentId++,
        status: "running",
        startedAt: Date.now(),
        toolUses: 0,
      });
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
      row.status = "done";
      row.doneAt = Date.now();
    }
    this.render();
  }

  agentFailed(label: string, error: unknown, id?: number): void {
    const row = this.findRow(label, id);
    if (row) {
      row.status = "failed";
      row.doneAt = Date.now();
      row.error = errorMessage(error);
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
      logs: [...this.logs],
    };
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
      const any = this.phases[i].agents.find((agent) => agent.label === label);
      if (any) return any;
    }
    return undefined;
  }

  private findRowById(id: number): AgentRow | undefined {
    for (const phase of this.phases) {
      const row = phase.agents.find((agent) => agent.id === id);
      if (row) return row;
    }
    return undefined;
  }

  private lines(): string[] {
    const out: string[] = [`⚙ ${this.title}`];
    for (const phase of this.phases) {
      if (phase.agents.length === 0 && phase.title === "Workflow") continue;
      out.push(`  ${phase.title}`);
      for (const agent of phase.agents) {
        const icon = agent.status === "done" ? "✓" : agent.status === "failed" ? "✗" : agent.status === "queued" ? "○" : "⏳";
        const tool = agent.status === "running" && agent.lastTool ? ` · ${agent.lastTool}` : "";
        const error = agent.status === "failed" && agent.error ? ` · ${agent.error}` : "";
        out.push(`    ${icon} ${agent.label}${tool}${error}`);
      }
    }
    const counterLine = [...this.counters.values()].map((counter) => `${counter.label}: ${counter.value}`).join(" · ");
    if (counterLine) out.push(`  ${counterLine}`);
    for (const line of this.logs.slice(-6)) out.push(`  · ${line}`);
    return out;
  }

  private render(): void {
    if (this.ctx.hasUI) this.ctx.ui.setWidget("workflow", this.lines());
  }

  /** Clear live workflow surfaces; optionally leave a one-line final status. */
  done(status?: string): void {
    this.doneAt = Date.now();
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget("workflow", undefined);
    this.ctx.ui.setStatus("workflow", status);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
