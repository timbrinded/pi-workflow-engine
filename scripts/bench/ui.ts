import { performance } from "node:perf_hooks";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ProgressTracker } from "../../.pi/extensions/pi-workflow-engine/src/progress.ts";
import type { AgentRowSnapshot, WorkflowLaneItemSnapshot, WorkflowProgressSnapshot } from "../../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import { statusText } from "../../.pi/extensions/pi-workflow-engine/src/ui/workflow-format.ts";
import { renderWorkflowWidgetLines } from "../../.pi/extensions/pi-workflow-engine/src/ui/workflow-widget.ts";
import { createTestTheme } from "../../tests/fixtures/theme.ts";
import { intFlag, maybeWriteBenchmarkOutput, parseBenchArgs, printBenchmarkOutput, runBenchmark } from "./lib.ts";

const options = parseBenchArgs();
const agents = intFlag(options, "agents", 500);
const laneItems = intFlag(options, "lane-items", 500);
const phases = intFlag(options, "phases", 5);
const iterations = options.iterations;
const theme = createTestTheme();
const snapshot = createSnapshot({ agents, laneItems, phases });

const statusTextMs = await runBenchmark("ui.status_text", iterations, () => {
  statusText(snapshot, theme);
});
const widgetRenderMs = await runBenchmark("ui.widget_render", iterations, () => {
  renderWorkflowWidgetLines(snapshot, theme);
});
const repeatRenderMs = await runBenchmark("ui.widget_repeat", iterations, () => {
  for (let i = 0; i < 100; i++) renderWorkflowWidgetLines(snapshot, theme);
});
const progressEventMs = await runBenchmark("ui.progress_events", iterations, () => {
  simulateProgressEvents(Math.min(agents, 1_000), Math.min(laneItems, 1_000));
});

const result = {
  benchmark: "ui",
  iterations,
  generatedAt: new Date().toISOString(),
  agents,
  laneItems,
  phases,
  statusTextMs,
  widgetRenderMs,
  repeatRenderMs,
  progressEventMs,
};

const written = await maybeWriteBenchmarkOutput("ui", result, options.out);
printBenchmarkOutput(written ? { ...result, written } : result, options.json);

function createSnapshot(config: { agents: number; laneItems: number; phases: number }): WorkflowProgressSnapshot {
  const phaseSnapshots = Array.from({ length: config.phases }, (_value, phaseIndex) => ({
    title: `Phase ${phaseIndex + 1}`,
    agents: createAgents(config.agents, config.phases, phaseIndex),
  }));
  const items: WorkflowLaneItemSnapshot[] = Array.from({ length: config.laneItems }, (_value, index) => ({
    lane: "Findings",
    title: `Finding ${index}`,
    subtitle: `src/file-${index % 20}.ts:${index + 1}`,
    status: index % 5 === 0 ? "warning" : "success",
    details: `Evidence ${index}`,
    createdAt: Date.now() + index,
  }));
  return {
    runId: "ui-benchmark",
    title: "bench-workflow",
    startedAt: Date.now() - 12_345,
    currentPhase: "Benchmark",
    phases: phaseSnapshots,
    counters: [
      { key: "files", label: "files", value: 42 },
      { key: "candidates", label: "candidates", value: config.laneItems },
      { key: "kept", label: "kept", value: Math.floor(config.laneItems / 2) },
    ],
    summary: [["mode", "synthetic"]],
    lanes: [["Findings", items]],
    laneOverflow: [],
    logs: ["synthetic render benchmark"],
  };
}

function createAgents(totalAgents: number, phaseCount: number, phaseIndex: number): AgentRowSnapshot[] {
  const count = Math.floor(totalAgents / phaseCount) + (phaseIndex < totalAgents % phaseCount ? 1 : 0);
  const offset = Math.floor(totalAgents / phaseCount) * phaseIndex + Math.min(phaseIndex, totalAgents % phaseCount);
  return Array.from({ length: count }, (_value, index) => {
    const id = offset + index + 1;
    const status = id % 17 === 0 ? "failed" : id % 5 === 0 ? "queued" : id % 3 === 0 ? "running" : "done";
    return {
      id,
      label: `agent:${id}`,
      status,
      startedAt: status === "queued" ? undefined : Date.now() - id * 10,
      doneAt: status === "done" || status === "failed" ? Date.now() : undefined,
      toolUses: id % 4,
      lastTool: id % 4 === 0 ? "read" : undefined,
      error: status === "failed" ? "synthetic failure" : undefined,
    };
  });
}

function simulateProgressEvents(agentCount: number, itemCount: number): void {
  const tracker = new ProgressTracker(fakeHeadlessContext(), "bench-progress", "ui-benchmark-progress");
  const start = performance.now();
  for (let i = 0; i < agentCount; i++) {
    const row = tracker.agentQueued("Bench", `agent:${i}`);
    tracker.agentStart("Bench", `agent:${i}`, row);
    if (i % 3 === 0) tracker.agentTool(`agent:${i}`, "read", row);
    tracker.agentDone(`agent:${i}`, row);
  }
  for (let i = 0; i < itemCount; i++) {
    tracker.event({ type: "lane_item", lane: "Findings", title: `Finding ${i}`, status: "pending" });
  }
  tracker.event({ type: "summary", key: "duration", value: performance.now() - start });
  tracker.done();
}

function fakeHeadlessContext(): ExtensionContext {
  return { hasUI: false } as unknown as ExtensionContext;
}
