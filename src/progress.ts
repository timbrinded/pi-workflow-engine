import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AgentRow {
  label: string;
  status: "running" | "done";
  lastTool?: string;
}

interface Phase {
  title: string;
  agents: AgentRow[];
}

/**
 * Renders a live phase/agent tree into the pi TUI via `ctx.ui.setWidget`.
 * In non-interactive modes (print/JSON/RPC) it falls back to terse stderr breadcrumbs
 * so it never corrupts stdout.
 */
export class ProgressTracker {
  private readonly phases: Phase[] = [];
  private readonly logs: string[] = [];
  private current = "Workflow";

  constructor(
    private readonly ctx: ExtensionContext,
    private readonly title: string,
  ) {
    this.ensurePhase(this.current);
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
    this.current = title;
    this.ensurePhase(title);
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${title}\n`);
    this.render();
  }

  log(message: string): void {
    this.logs.push(message);
    if (this.logs.length > 6) this.logs.shift();
    if (!this.ctx.hasUI) process.stderr.write(`[${this.title}] ${message}\n`);
    this.render();
  }

  agentStart(phase: string | undefined, label: string): void {
    this.ensurePhase(phase ?? this.current).agents.push({ label, status: "running" });
    this.render();
  }

  agentTool(label: string, tool: string): void {
    const row = this.findRow(label);
    if (row) row.lastTool = tool;
    this.render();
  }

  agentDone(label: string): void {
    const row = this.findRow(label);
    if (row && row.status === "running") row.status = "done";
    this.render();
  }

  private findRow(label: string): AgentRow | undefined {
    for (let i = this.phases.length - 1; i >= 0; i--) {
      const running = this.phases[i].agents.find((agent) => agent.label === label && agent.status === "running");
      if (running) return running;
    }
    for (let i = this.phases.length - 1; i >= 0; i--) {
      const any = this.phases[i].agents.find((agent) => agent.label === label);
      if (any) return any;
    }
    return undefined;
  }

  private lines(): string[] {
    const out: string[] = [`⚙ ${this.title}`];
    for (const phase of this.phases) {
      if (phase.agents.length === 0 && phase.title === "Workflow") continue;
      out.push(`  ${phase.title}`);
      for (const agent of phase.agents) {
        const icon = agent.status === "done" ? "✓" : "⏳";
        const tool = agent.status === "running" && agent.lastTool ? ` · ${agent.lastTool}` : "";
        out.push(`    ${icon} ${agent.label}${tool}`);
      }
    }
    for (const line of this.logs) out.push(`  · ${line}`);
    return out;
  }

  private render(): void {
    if (this.ctx.hasUI) this.ctx.ui.setWidget("workflow", this.lines());
  }

  /** Clear the widget; optionally leave a one-line status in the footer. */
  done(status?: string): void {
    if (!this.ctx.hasUI) return;
    this.ctx.ui.setWidget("workflow", undefined);
    this.ctx.ui.setStatus("workflow", status);
  }
}
