import assert from "node:assert/strict";
import { test } from "bun:test";
import { parallel, pipeline, Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("Semaphore caps concurrent work", async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maxSeen = 0;

  const results = await Promise.all(
    [0, 1, 2, 3, 4].map((value) =>
      semaphore.run(async () => {
        active++;
        maxSeen = Math.max(maxSeen, active);
        await delay(5);
        active--;
        return value;
      }),
    ),
  );

  assert.equal(maxSeen, 2);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(active, 0);
});

test("Semaphore releases its slot after a failure", async () => {
  const semaphore = new Semaphore(1);

  await assert.rejects(
    semaphore.run(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  const value = await semaphore.run(async () => "after failure");
  assert.equal(value, "after failure");
});

test("parallel preserves input order", async () => {
  const results = await parallel([
    async () => {
      await delay(8);
      return "first";
    },
    async () => {
      await delay(1);
      return "second";
    },
    async () => "third",
  ]);

  assert.deepEqual(results, ["first", "second", "third"]);
});

test("pipeline passes previous result, original item, and index through stages", async () => {
  interface StageRecord {
    readonly stage: 1 | 2;
    readonly prev: number;
    readonly item: number;
    readonly index: number;
  }

  const records: StageRecord[] = [];
  const results = await pipeline(
    [2, 4],
    async (prev, item, index) => {
      records.push({ stage: 1, prev, item, index });
      return prev + index;
    },
    async (prev, item, index) => {
      records.push({ stage: 2, prev, item, index });
      return prev * item;
    },
  );

  assert.deepEqual(results, [4, 20]);
  assert.deepEqual(
    records.sort((a, b) => a.stage - b.stage || a.index - b.index),
    [
      { stage: 1, prev: 2, item: 2, index: 0 },
      { stage: 1, prev: 4, item: 4, index: 1 },
      { stage: 2, prev: 2, item: 2, index: 0 },
      { stage: 2, prev: 5, item: 4, index: 1 },
    ],
  );
});
