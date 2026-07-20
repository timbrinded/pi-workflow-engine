import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRowSnapshot, WorkflowLaneItemSnapshot, WorkflowProgressSnapshot } from "../progress-types.ts";
import { formatWorkflowUsageLine } from "../usage.ts";
import { agentDetailParts, formatCount, formatDuration, statusIcon, truncateDisplay } from "./workflow-format.ts";
import { workflowViewerHeight } from "./workflow-viewer-layout.ts";

type Section = "Overview" | "Agents" | "Findings" | "Logs" | "Result";

interface InspectorLine {
  text: string;
  selectable?: boolean;
  key?: string;
}

const BASE_SECTIONS: readonly Section[] = ["Overview", "Agents", "Findings", "Logs"];
const RESULT_SECTIONS: readonly Section[] = [...BASE_SECTIONS, "Result"];
const MAX_RESULT_SOURCE_LINES = 200;
const MAX_RESULT_RENDERED_LINES = 400;

export interface WorkflowInspectorOutcome {
  readonly label: string;
  readonly text: string;
}

export class WorkflowInspector {
  private sectionIndex = 0;
  private contentWidth = 80;
  private readonly selected: Record<Section, number> = { Overview: 0, Agents: 0, Findings: 0, Logs: 0, Result: 0 };
  private readonly expanded = new Set<string>();

  constructor(
    private readonly snapshotProvider: () => WorkflowProgressSnapshot,
    private readonly tui: Pick<TUI, "requestRender" | "terminal">,
    private readonly theme: Theme,
    private readonly close: () => void,
    private readonly outcome?: WorkflowInspectorOutcome,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.close();
      return;
    }

    if (matchesKey(data, "tab")) {
      this.sectionIndex = (this.sectionIndex + 1) % this.sections().length;
      this.requestRender();
      return;
    }

    const section = this.currentSection();
    const count = this.itemCount(section);
    if (matchesKey(data, "up")) {
      this.selected[section] = Math.max(0, this.selected[section] - 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "down")) {
      this.selected[section] = Math.min(Math.max(0, count - 1), this.selected[section] + 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return") || matchesKey(data, "enter")) {
      const key = this.selectedKey(section);
      if (key) {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.requestRender();
      }
    }
  }

  render(width: number): string[] {
    const w = Math.max(4, width);
    const inner = Math.max(1, w - 4);
    this.contentWidth = inner;
    const th = this.theme;
    const snapshot = this.snapshotProvider();
    const section = this.currentSection();
    let body = this.sectionLines(section, snapshot, inner);
    const selectableCount = body.filter((line) => line.selectable).length;
    const clampedSelection = Math.min(Math.max(0, selectableCount - 1), this.selected[section]);
    if (clampedSelection !== this.selected[section]) {
      this.selected[section] = clampedSelection;
      body = this.sectionLines(section, snapshot, inner);
    }
    const innerHeight = Math.max(1, workflowViewerHeight(this.tui.terminal.rows) - 2);
    const maxBody = Math.max(1, innerHeight - 5);
    const selectedLine = this.selectedLineIndex(body);
    const maxStart = Math.max(0, body.length - maxBody);
    const start = Math.min(maxStart, Math.max(0, selectedLine - Math.floor(maxBody / 2)));
    const visible = body.slice(start, start + maxBody);
    const visibleEnd = Math.min(body.length, start + visible.length);
    const pct = body.length <= maxBody ? "100%" : `${Math.round((visibleEnd / body.length) * 100)}%`;
    const selected = this.selected[section] + 1;
    const count = Math.max(1, selectableCount);
    const content = fitRows(visible.map((line) => line.text), maxBody);
    const interior = fitRows(
      [
        ` ${th.fg("accent", th.bold("Workflow Inspector"))} ${th.fg("dim", snapshot.title)}`,
        ` ${this.tabs()}`,
        th.fg("dim", "─".repeat(inner)),
        ...content,
        th.fg("dim", "─".repeat(inner)),
        `${th.fg("dim", `${body.length} lines · ${pct} · ${selected}/${count}`)} ${th.fg("dim", "· tab sections · ↑↓ select · enter expand/collapse · q/esc close")}`,
      ],
      innerHeight,
    );
    return [
      th.fg("border", `╭${"─".repeat(Math.max(0, w - 2))}╮`),
      ...interior.map((line) => this.row(line, inner)),
      th.fg("border", `╰${"─".repeat(Math.max(0, w - 2))}╯`),
    ].map((line) => truncateDisplay(line, w));
  }

  invalidate(): void {}

  private currentSection(): Section {
    return this.sections()[this.sectionIndex] ?? "Overview";
  }

  private sections(): readonly Section[] {
    return this.outcome ? RESULT_SECTIONS : BASE_SECTIONS;
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private tabs(): string {
    return this.sections().map((section, index) => {
      return index === this.sectionIndex ? this.theme.fg("accent", this.theme.bold(section)) : this.theme.fg("muted", section);
    }).join(this.theme.fg("dim", "  |  "));
  }

  private row(content: string, innerWidth: number): string {
    const padded = padRight(truncateDisplay(content, innerWidth), innerWidth);
    return this.theme.fg("border", "│") + " " + padded + " " + this.theme.fg("border", "│");
  }

  private itemCount(section: Section): number {
    return this.sectionLines(section, this.snapshotProvider(), this.contentWidth).filter((line) => line.selectable).length;
  }

  private selectedKey(section: Section): string | undefined {
    let index = -1;
    for (const line of this.sectionLines(section, this.snapshotProvider(), this.contentWidth)) {
      if (!line.selectable) continue;
      index++;
      if (index === this.selected[section]) return line.key;
    }
    return undefined;
  }

  private selectedLineIndex(lines: readonly InspectorLine[]): number {
    let index = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].selectable) continue;
      index++;
      if (index === this.selected[this.currentSection()]) return i;
    }
    return 0;
  }

  private sectionLines(section: Section, snapshot: WorkflowProgressSnapshot, width: number): InspectorLine[] {
    switch (section) {
      case "Overview":
        return this.overviewLines(snapshot, width);
      case "Agents":
        return this.agentLines(snapshot, width);
      case "Findings":
        return this.findingLines(snapshot, width);
      case "Logs":
        return this.logLines(snapshot);
      case "Result":
        return this.resultLines(width);
    }
  }

  private overviewLines(snapshot: WorkflowProgressSnapshot, width: number): InspectorLine[] {
    const elapsed = formatDuration((snapshot.doneAt ?? Date.now()) - snapshot.startedAt);
    const lines: InspectorLine[] = [
      { text: `${this.theme.fg("muted", "Phase")} ${this.theme.fg("accent", snapshot.currentPhase)}`, selectable: true, key: "overview:phase" },
      { text: `${this.theme.fg("muted", "Elapsed")} ${elapsed}`, selectable: true, key: "overview:elapsed" },
    ];
    const usage = formatWorkflowUsageLine(snapshot.usage);
    if (usage) lines.push({ text: usage, selectable: true, key: "overview:usage" });
    if (snapshot.counters.length > 0) {
      lines.push({ text: this.theme.fg("dim", "Counters") });
      for (const counter of snapshot.counters) {
        lines.push({ text: `  ${counter.label}: ${formatCount(counter.value)}`, selectable: true, key: `counter:${counter.key}` });
      }
    }
    if (snapshot.summary.length > 0) {
      lines.push({ text: this.theme.fg("dim", "Summary") });
      for (const [key, value] of snapshot.summary) {
        lines.push({ text: truncateDisplay(`  ${key}: ${value}`, width), selectable: true, key: `summary:${key}` });
      }
    }
    return lines;
  }

  private agentLines(snapshot: WorkflowProgressSnapshot, _width: number): InspectorLine[] {
    const lines: InspectorLine[] = [];
    let selectableIndex = -1;
    for (const phase of snapshot.phases) {
      if (phase.agents.length === 0) continue;
      lines.push({ text: this.theme.fg("dim", phase.title) });
      for (const agent of phase.agents) {
        selectableIndex++;
        const key = `agent:${agent.id}`;
        const selected = this.currentSection() === "Agents" && this.selected.Agents === selectableIndex;
        lines.push({ text: this.agentLine(agent, selected), selectable: true, key });
        if (this.expanded.has(key)) lines.push(...this.agentDetails(agent));
      }
    }
    return lines.length > 0 ? lines : [{ text: this.theme.fg("dim", "No agents yet.") }];
  }

  private agentLine(agent: AgentRowSnapshot, selected: boolean): string {
    const details = agentDetailParts(agent);
    const suffix = details.length > 0 ? ` ${this.theme.fg("dim", `· ${details.join(" · ")}`)}` : "";
    const text = `${statusIcon(agent.status, this.theme)} ${agent.label}${suffix}`;
    return selected ? this.theme.bg("selectedBg", text) : text;
  }

  private agentDetails(agent: AgentRowSnapshot): InspectorLine[] {
    const lines: InspectorLine[] = [];
    if (agent.error) lines.push({ text: `    ${this.theme.fg("error", `Error: ${agent.error}`)}` });
    if (agent.lastTool) lines.push({ text: `    ${this.theme.fg("dim", `Last tool: ${agent.lastTool}`)}` });
    return lines.length > 0 ? lines : [{ text: `    ${this.theme.fg("dim", "No details yet.")}` }];
  }

  private findingLines(snapshot: WorkflowProgressSnapshot, width: number): InspectorLine[] {
    const lines: InspectorLine[] = [];
    let selectableIndex = -1;
    const overflowByLane = new Map(snapshot.laneOverflow);
    for (const [lane, items] of snapshot.lanes) {
      const hidden = overflowByLane.get(lane) ?? 0;
      const countText = hidden > 0 ? `${items.length} shown, ${hidden} hidden` : `${items.length}`;
      lines.push({ text: this.theme.fg("dim", `${lane} (${countText})`) });
      items.forEach((item, index) => {
        selectableIndex++;
        const key = `finding:${lane}:${index}:${item.createdAt}`;
        const selected = this.currentSection() === "Findings" && this.selected.Findings === selectableIndex;
        lines.push({ text: this.findingLine(item, selected), selectable: true, key });
        if (this.expanded.has(key)) lines.push(...this.findingDetails(item, width));
      });
    }
    return lines.length > 0 ? lines : [{ text: this.theme.fg("dim", "No findings lanes yet.") }];
  }

  private findingLine(item: WorkflowLaneItemSnapshot, selected: boolean): string {
    const subtitle = item.subtitle ? ` ${this.theme.fg("accent", item.subtitle)}` : "";
    const text = `${statusIcon(item.status, this.theme)} ${item.title}${subtitle}`;
    return selected ? this.theme.bg("selectedBg", text) : text;
  }

  private findingDetails(item: WorkflowLaneItemSnapshot, width: number): InspectorLine[] {
    return [
      ...this.detailFieldLines("Title", item.title, width, "text"),
      ...this.detailFieldLines("Location", item.subtitle || "(unknown)", width, "accent"),
      ...this.detailFieldLines("Status", item.status, width, "muted"),
      ...this.detailFieldLines("Details", item.details || "(no details)", width, "muted"),
    ];
  }

  private detailFieldLines(label: string, value: string, width: number, color: Parameters<Theme["fg"]>[0]): InspectorLine[] {
    const plainPrefix = `  ${label}: `;
    const prefix = `    ${this.theme.fg("dim", `${label}:`)} `;
    const continuation = `    ${" ".repeat(visibleWidth(`${label}: `))}`;
    const wrapped = wrapTextWithAnsi(this.theme.fg(color, value), Math.max(10, width - visibleWidth(plainPrefix) - 4));
    if (wrapped.length === 0) return [{ text: prefix }];
    return wrapped.map((line, index) => ({ text: `${index === 0 ? prefix : continuation}${line}` }));
  }

  private logLines(snapshot: WorkflowProgressSnapshot): InspectorLine[] {
    if (snapshot.logs.length === 0) return [{ text: this.theme.fg("dim", "No logs yet.") }];
    return snapshot.logs.map((log, index) => {
      const key = `log:${index}`;
      const selected = this.currentSection() === "Logs" && this.selected.Logs === index;
      const text = selected ? this.theme.bg("selectedBg", log) : log;
      return { text, selectable: true, key };
    });
  }

  private resultLines(width: number): InspectorLine[] {
    if (!this.outcome) return [{ text: this.theme.fg("dim", "No retained outcome is available for this run.") }];
    const source = this.outcome.text.split("\n");
    const lines: InspectorLine[] = [{ text: this.theme.fg("dim", this.outcome.label) }];
    const shown = source.slice(0, MAX_RESULT_SOURCE_LINES);
    for (const sourceLine of shown) {
      const wrapped = wrapTextWithAnsi(sourceLine || " ", Math.max(10, width - 2));
      for (const line of wrapped) {
        if (lines.length >= MAX_RESULT_RENDERED_LINES) break;
        const index = lines.length;
        const selected = this.currentSection() === "Result" && this.selected.Result === index - 1;
        const text = selected ? this.theme.bg("selectedBg", line) : line;
        lines.push({ text, selectable: true, key: `result:${index}` });
      }
      if (lines.length >= MAX_RESULT_RENDERED_LINES) break;
    }
    if (shown.length < source.length || lines.length >= MAX_RESULT_RENDERED_LINES) {
      lines.push({ text: this.theme.fg("dim", "… retained result truncated for display") });
    }
    return lines;
  }
}

function padRight(text: string, width: number): string {
  const visible = visibleWidth(text);
  return text + " ".repeat(Math.max(0, width - visible));
}

function fitRows(lines: readonly string[], height: number): string[] {
  const visible = lines.slice(0, Math.max(0, height));
  return [...visible, ...Array.from({ length: Math.max(0, height - visible.length) }, () => "")];
}
