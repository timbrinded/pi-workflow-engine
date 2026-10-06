import assert from "node:assert/strict";
import { test } from "bun:test";
import { createPerfRecorder, NoopPerfRecorder, PerfRecorder, type PerfSink } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";

function aggregateValue(recorder: PerfRecorder, name: string): number {
  const aggregate = recorder.snapshot().aggregates.find((entry) => entry.name === name);
  assert.ok(aggregate, `missing aggregate ${name}`);
  return aggregate.total;
}

test("PerfRecorder aggregates observed values and percentiles", () => {
  const recorder = new PerfRecorder();
  for (let i = 1; i <= 100; i++) recorder.observe("queue", i);
  recorder.counter("misses", 2);
  recorder.counter("misses", 3);

  const snapshot = recorder.snapshot();
  const queue = snapshot.aggregates.find((entry) => entry.name === "queue");
  assert.ok(queue);
  assert.equal(snapshot.enabled, true);
  assert.equal(queue.count, 100);
  assert.equal(queue.total, 5050);
  assert.equal(queue.min, 1);
  assert.equal(queue.max, 100);
  assert.equal(queue.mean, 50.5);
  assert.equal(queue.p50, 50);
  assert.equal(queue.p95, 95);
  assert.equal(aggregateValue(recorder, "misses"), 5);
});

test("PerfRecorder records async and sync durations", async () => {
  const recorder = new PerfRecorder();

  const syncValue = recorder.timeSync("sync", () => 42);
  const asyncValue = await recorder.time("async", async () => "ok");

  assert.equal(syncValue, 42);
  assert.equal(asyncValue, "ok");
  const snapshot = recorder.snapshot();
  assert.equal(snapshot.aggregates.find((entry) => entry.name === "sync")?.count, 1);
  assert.equal(snapshot.aggregates.find((entry) => entry.name === "async")?.count, 1);
  assert.ok((snapshot.aggregates.find((entry) => entry.name === "sync")?.min ?? -1) >= 0);
  assert.ok((snapshot.aggregates.find((entry) => entry.name === "async")?.min ?? -1) >= 0);
});

test("NoopPerfRecorder executes functions without retaining samples", async () => {
  const recorder: PerfSink = new NoopPerfRecorder();
  recorder.observe("ignored", 10);
  recorder.counter("ignored");

  const syncValue = recorder.timeSync("sync", () => "sync");
  const asyncValue = await recorder.time("async", async () => "async");

  assert.equal(syncValue, "sync");
  assert.equal(asyncValue, "async");
  assert.deepEqual(recorder.snapshot(), { enabled: false, aggregates: [] });
});

test("createPerfRecorder returns enabled or disabled recorders", () => {
  assert.equal(createPerfRecorder(true).snapshot().enabled, true);
  assert.equal(createPerfRecorder(false).snapshot().enabled, false);
});
