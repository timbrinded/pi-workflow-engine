export interface WorkflowUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export type WorkflowUsageCoverage = "none" | "partial" | "complete";

export interface WorkflowUsageComponentCoverage {
  readonly input: WorkflowUsageCoverage;
  readonly output: WorkflowUsageCoverage;
  readonly cacheRead: WorkflowUsageCoverage;
  readonly cacheWrite: WorkflowUsageCoverage;
}

export interface WorkflowUsageTotals {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly coverage: WorkflowUsageComponentCoverage;
  readonly cost: WorkflowUsageCost;
}

export interface WorkflowAgentUsage {
  readonly label: string;
  readonly phase?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly assistantMessages: number;
  readonly usage: WorkflowUsageTotals;
}

export interface WorkflowUsageSnapshot {
  readonly agents: readonly WorkflowAgentUsage[];
  readonly totals: WorkflowUsageTotals;
  readonly assistantMessages: number;
}

export interface WorkflowUsageSink {
  recordAgentSession(input: { label: string; phase?: string; messages: readonly unknown[] }): void;
  snapshot(): WorkflowUsageSnapshot;
}

const ZERO_COST: WorkflowUsageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
const ZERO_COVERAGE: WorkflowUsageComponentCoverage = {
  input: "none",
  output: "none",
  cacheRead: "none",
  cacheWrite: "none",
};
const ZERO_TOTALS: WorkflowUsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  coverage: ZERO_COVERAGE,
  cost: ZERO_COST,
};

interface AssistantUsageMessage {
  readonly provider?: string;
  readonly model?: string;
  readonly usage: WorkflowUsageTotals;
}

export class WorkflowUsageRecorder implements WorkflowUsageSink {
  private readonly agents: WorkflowAgentUsage[] = [];

  constructor(private readonly onSnapshot?: (snapshot: WorkflowUsageSnapshot) => void) {}

  recordAgentSession(input: { label: string; phase?: string; messages: readonly unknown[] }): void {
    const assistantMessages = input.messages.flatMap((message) => {
      const parsed = parseAssistantUsageMessage(message);
      return parsed ? [parsed] : [];
    });
    if (assistantMessages.length === 0) return;

    const usage = sumTotals(assistantMessages.map((message) => message.usage));
    const latestMetadata = assistantMessages.findLast((message) => message.provider !== undefined || message.model !== undefined);
    this.agents.push({
      label: input.label,
      phase: input.phase,
      provider: latestMetadata?.provider,
      model: latestMetadata?.model,
      assistantMessages: assistantMessages.length,
      usage,
    });
    this.onSnapshot?.(this.snapshot());
  }

  snapshot(): WorkflowUsageSnapshot {
    const agents = this.agents.map((agent) => ({
      ...agent,
      usage: cloneTotals(agent.usage),
    }));
    return {
      agents,
      totals: sumTotals(agents.map((agent) => agent.usage)),
      assistantMessages: agents.reduce((sum, agent) => sum + agent.assistantMessages, 0),
    };
  }
}

export function createWorkflowUsageRecorder(onSnapshot?: (snapshot: WorkflowUsageSnapshot) => void): WorkflowUsageSink {
  return new WorkflowUsageRecorder(onSnapshot);
}

export function emptyWorkflowUsageTotals(): WorkflowUsageTotals {
  return cloneTotals(ZERO_TOTALS);
}

export function isWorkflowUsageSnapshot(value: unknown): value is WorkflowUsageSnapshot {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.agents) || !value.agents.every(isWorkflowAgentUsage)) return false;
  if (!isWorkflowUsageTotals(value.totals)) return false;
  return finiteNumber(value.assistantMessages) !== undefined;
}

export function hasWorkflowUsage(snapshot: unknown): snapshot is WorkflowUsageSnapshot {
  if (!isWorkflowUsageSnapshot(snapshot)) return false;
  return snapshot.totals.totalTokens > 0 || snapshot.totals.cost.total > 0;
}

export function formatWorkflowUsageLine(snapshot: unknown): string | undefined {
  if (!hasWorkflowUsage(snapshot)) return undefined;
  const parts = formatWorkflowUsageComponents(snapshot.totals);
  parts.push(`cost $${snapshot.totals.cost.total.toFixed(3)}`);
  parts.push(`agents ${snapshot.agents.length}`);
  return `Usage: ${parts.join(" · ")}`;
}

function formatWorkflowUsageComponents(totals: WorkflowUsageTotals): string[] {
  const parts: string[] = [];
  const completeCacheBreakdown =
    totals.coverage.cacheRead === "complete" && totals.coverage.cacheWrite === "complete";
  appendUsageComponent(parts, completeCacheBreakdown ? "fresh" : "input", totals.input, totals.coverage.input);
  appendUsageComponent(parts, "cache read", totals.cacheRead, totals.coverage.cacheRead);
  appendUsageComponent(parts, "cache write", totals.cacheWrite, totals.coverage.cacheWrite);
  appendUsageComponent(parts, "output", totals.output, totals.coverage.output);

  const knownComponents = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  if (parts.length === 0 && totals.totalTokens > 0) parts.push(`tokens ${formatUsageCount(totals.totalTokens)}`);
  else if (!hasCompleteCoverage(totals.coverage) && totals.totalTokens !== knownComponents) {
    parts.push(`total ${formatUsageCount(totals.totalTokens)}`);
  }
  return parts;
}

function appendUsageComponent(
  parts: string[],
  label: string,
  value: number,
  coverage: WorkflowUsageCoverage,
): void {
  if (value <= 0 || coverage === "none") return;
  const count = formatUsageCount(value);
  parts.push(`${label} ${coverage === "partial" ? `≥${count}` : count}`);
}

function isWorkflowAgentUsage(value: unknown): value is WorkflowAgentUsage {
  if (!isRecord(value)) return false;
  if (typeof value.label !== "string") return false;
  if (value.phase !== undefined && typeof value.phase !== "string") return false;
  if (value.provider !== undefined && typeof value.provider !== "string") return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (finiteNumber(value.assistantMessages) === undefined) return false;
  return isWorkflowUsageTotals(value.usage);
}

function isWorkflowUsageTotals(value: unknown): value is WorkflowUsageTotals {
  if (!isRecord(value)) return false;
  if (finiteNumber(value.input) === undefined) return false;
  if (finiteNumber(value.output) === undefined) return false;
  if (finiteNumber(value.cacheRead) === undefined) return false;
  if (finiteNumber(value.cacheWrite) === undefined) return false;
  if (finiteNumber(value.totalTokens) === undefined) return false;
  if (!isWorkflowUsageCoverage(value.coverage)) return false;
  return isWorkflowUsageCost(value.cost);
}

function isWorkflowUsageCoverage(value: unknown): value is WorkflowUsageComponentCoverage {
  if (!isRecord(value)) return false;
  return (
    isCoverageValue(value.input) &&
    isCoverageValue(value.output) &&
    isCoverageValue(value.cacheRead) &&
    isCoverageValue(value.cacheWrite)
  );
}

function isWorkflowUsageCost(value: unknown): value is WorkflowUsageCost {
  if (!isRecord(value)) return false;
  return (
    finiteNumber(value.input) !== undefined &&
    finiteNumber(value.output) !== undefined &&
    finiteNumber(value.cacheRead) !== undefined &&
    finiteNumber(value.cacheWrite) !== undefined &&
    finiteNumber(value.total) !== undefined
  );
}

function parseAssistantUsageMessage(message: unknown): AssistantUsageMessage | undefined {
  if (!isRecord(message)) return undefined;
  if (message.role !== "assistant") return undefined;
  const usage = parseUsageTotals(message.usage);
  if (!usage) return undefined;
  return {
    provider: typeof message.provider === "string" ? message.provider : undefined,
    model: typeof message.model === "string" ? message.model : undefined,
    usage,
  };
}

function parseUsageTotals(value: unknown): WorkflowUsageTotals | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.input);
  const output = finiteNumber(value.output);
  const cacheRead = finiteNumber(value.cacheRead);
  const cacheWrite = finiteNumber(value.cacheWrite);
  const reportedTotal = finiteNumber(value.totalTokens);
  const cost = parseUsageCost(value.cost);
  if (!cost) return undefined;
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined && reportedTotal === undefined) {
    return undefined;
  }
  const coverage: WorkflowUsageComponentCoverage = {
    input: input === undefined ? "none" : "complete",
    output: output === undefined ? "none" : "complete",
    cacheRead: cacheRead === undefined ? "none" : "complete",
    cacheWrite: cacheWrite === undefined ? "none" : "complete",
  };
  const componentTotal = (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    totalTokens: hasCompleteCoverage(coverage) ? componentTotal : (reportedTotal ?? componentTotal),
    coverage,
    cost,
  };
}

function parseUsageCost(value: unknown): WorkflowUsageCost | undefined {
  if (!isRecord(value)) return undefined;
  const input = finiteNumber(value.input);
  const output = finiteNumber(value.output);
  const cacheRead = finiteNumber(value.cacheRead);
  const cacheWrite = finiteNumber(value.cacheWrite);
  const total = finiteNumber(value.total);
  if (total === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    total,
  };
}

function sumTotals(values: readonly WorkflowUsageTotals[]): WorkflowUsageTotals {
  const [first, ...rest] = values;
  if (!first) return emptyWorkflowUsageTotals();
  return rest.reduce(addTotals, cloneTotals(first));
}

function addTotals(left: WorkflowUsageTotals, right: WorkflowUsageTotals): WorkflowUsageTotals {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    coverage: {
      input: combineCoverage(left.coverage.input, right.coverage.input),
      output: combineCoverage(left.coverage.output, right.coverage.output),
      cacheRead: combineCoverage(left.coverage.cacheRead, right.coverage.cacheRead),
      cacheWrite: combineCoverage(left.coverage.cacheWrite, right.coverage.cacheWrite),
    },
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  };
}

function cloneTotals(value: WorkflowUsageTotals): WorkflowUsageTotals {
  return {
    input: value.input,
    output: value.output,
    cacheRead: value.cacheRead,
    cacheWrite: value.cacheWrite,
    totalTokens: value.totalTokens,
    coverage: { ...value.coverage },
    cost: { ...value.cost },
  };
}

function combineCoverage(left: WorkflowUsageCoverage, right: WorkflowUsageCoverage): WorkflowUsageCoverage {
  return left === right ? left : "partial";
}

function hasCompleteCoverage(coverage: WorkflowUsageComponentCoverage): boolean {
  return (
    coverage.input === "complete" &&
    coverage.output === "complete" &&
    coverage.cacheRead === "complete" &&
    coverage.cacheWrite === "complete"
  );
}

function isCoverageValue(value: unknown): value is WorkflowUsageCoverage {
  return value === "none" || value === "partial" || value === "complete";
}

function formatUsageCount(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
