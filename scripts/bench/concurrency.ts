import { performance } from "node:perf_hooks";
import { parallel, pipeline, Semaphore } from "../../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder, type PerfAggregate } from "../../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { intFlag, maybeWriteBenchmarkOutput, parseBenchArgs, printBenchmarkOutput, runBenchmark } from "./lib.ts";

interface ScenarioResult {
  readonly scenario: string;
  readonly items: number;
  readonly concurrency?: number;
  readonly stages?: number;
  readonly totalMs: number;
  readonly throughputPerSecond: number;
  readonly queueWait?: PerfAggregate;
  readonly mode?: string;
}

const options = parseBenchArgs();
const selectedItems = options.flags.has("items") ? [intFlag(options, "items", 200)] : [50, 200, 1000];
const concurrency = intFlag(options, "concurrency", 8);
const iterations = options.iterations;

const scenarios: ScenarioResult[] = [];
for (const items of selectedItems) {
  scenarios.push(await runSemaphoreScenario(items, concurrency));
  scenarios.push(await runParallelScenario(items));
  scenarios.push(await runParallelScenario(items, concurrency));
  for (const stages of [1, 2, 3]) scenarios.push(await runPipelineScenario(items, stages));
}

const result = {
  benchmark: "concurrency",
  iterations,
  generatedAt: new Date().toISOString(),
  scenarios,
  summary: await runBenchmark("concurrency.noop", iterations, () => {}),
};

const written = await maybeWriteBenchmarkOutput("concurrency", result, options.out);
printBenchmarkOutput(written ? { ...result, written } : result, options.json);

async function runSemaphoreScenario(items: number, concurrencyLimit: number): Promise<ScenarioResult> {
  const perf = new PerfRecorder();
  const semaphore = new Semaphore(concurrencyLimit);
  const start = performance.now();
  await Promise.all(
    Array.from({ length: items }, () =>
      semaphore.run(async () => delay(1), {
        onQueueWaitMs: (durationMs) => perf.observe("queue_wait_ms", durationMs),
      }),
    ),
  );
  const totalMs = performance.now() - start;
  return {
    scenario: "semaphore",
    items,
    concurrency: concurrencyLimit,
    totalMs,
    throughputPerSecond: throughput(items, totalMs),
    queueWait: perf.snapshot().aggregates.find((aggregate) => aggregate.name === "queue_wait_ms"),
  };
}

async function runParallelScenario(items: number, limit?: number): Promise<ScenarioResult> {
  const start = performance.now();
  const results = await parallel(
    Array.from({ length: items }, (_value, index) => async () => {
      await delay(0);
      return index;
    }),
    limit === undefined ? undefined : { limit },
  );
  const totalMs = performance.now() - start;
  if (results.length !== items || results[0] !== 0 || results[results.length - 1] !== items - 1) {
    throw new Error("parallel did not preserve result order");
  }
  return {
    scenario: "parallel",
    items,
    concurrency: limit,
    totalMs,
    throughputPerSecond: throughput(items, totalMs),
    mode: limit === undefined ? "eager" : "bounded",
  };
}

async function runPipelineScenario(items: number, stages: number): Promise<ScenarioResult> {
  const stageFns: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>> = Array.from(
    { length: stages },
    () => async (prev) => Promise.resolve(typeof prev === "number" ? prev + 1 : 1),
  );
  const start = performance.now();
  await pipeline(
    Array.from({ length: items }, (_value, index) => index),
    ...stageFns
  );
  const totalMs = performance.now() - start;
  return {
    scenario: "pipeline",
    items,
    stages,
    totalMs,
    throughputPerSecond: throughput(items, totalMs),
  };
}

function throughput(items: number, totalMs: number): number {
  return totalMs <= 0 ? items : items / (totalMs / 1_000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
