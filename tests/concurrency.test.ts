import assert from "node:assert/strict";
import { test } from "bun:test";
import { WorkflowBudgetExceededError } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { parallel, pipeline, pipelineWithOptions, Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";

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

test("parallel limits eager submission while preserving order", async () => {
  let started = 0;
  let active = 0;
  let maxActive = 0;
  const running = parallel(
    [0, 1, 2, 3, 4].map((value) => async () => {
      started++;
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      return value;
    }),
    { limit: 2 },
  );

  await delay(1);
  assert.equal(started, 2);
  const results = await running;
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.equal(maxActive, 2);
});

test("parallel resolves a throwing thunk to null and keeps survivors", async () => {
  const results = await parallel([
    async () => {
      await delay(4);
      return "first";
    },
    async () => {
      throw new Error("boom");
    },
    async () => "third",
  ]);

  assert.deepEqual(results, ["first", null, "third"]);
});

test("parallel still rejects on run abort", async () => {
  const controller = new AbortController();
  const running = parallel(
    [
      async () => {
        await delay(20);
        return "late";
      },
      async () => {
        await delay(20);
        return "also late";
      },
    ],
    { signal: controller.signal },
  );

  controller.abort(new WorkflowAbortError("stop"));

  await assert.rejects(running, /stop/);
});

test("parallel treats budget exhaustion as a null slot", async () => {
  const results = await parallel([
    async () => 1,
    async () => {
      throw new WorkflowBudgetExceededError(10, 12);
    },
    async () => 3,
  ]);

  assert.deepEqual(results, [1, null, 3]);
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

test("pipeline drops a failing item to null and skips its remaining stages", async () => {
  const stage3Items: number[] = [];

  const results = await pipeline(
    [1, 2, 3],
    async (prev) => prev * 2,
    async (prev, item) => {
      if (item === 2) throw new Error("bad item");
      return prev + 1;
    },
    async (prev, item) => {
      stage3Items.push(item);
      return prev * 10;
    },
  );

  assert.deepEqual(results, [30, null, 70]);
  assert.deepEqual(stage3Items, [1, 3]);
});

test("pipeline rejects a plain error observed after run abort", async () => {
  const controller = new AbortController();

  await assert.rejects(
    pipelineWithOptions(
      [1],
      [
        async () => {
          controller.abort(new WorkflowAbortError("stop"));
          throw new Error("plain after abort");
        },
      ],
      { signal: controller.signal, abortController: controller },
    ),
    /plain after abort/,
  );
});

test("pipeline aborts sibling item chains after a fatal failure", async () => {
  const controller = new AbortController();
  let siblingStage2Ran = false;

  const running = pipelineWithOptions(
    [1, 2],
    [
      async (_prev, item) => {
        if (item === 1) {
          await delay(1);
          throw new WorkflowAbortError("fatal");
        }
        await delay(10);
        return item;
      },
      async (prev) => {
        siblingStage2Ran = true;
        return prev;
      },
    ],
    { signal: controller.signal, abortController: controller },
  );

  await assert.rejects(running, /fatal/);
  await delay(20);
  assert.equal(controller.signal.aborted, true);
  assert.equal(siblingStage2Ran, false);
});

test("pipeline propagates a fatal abort", async () => {
  await assert.rejects(
    pipeline(
      [1, 2],
      async (prev) => prev,
      async (prev, item) => {
        if (item === 2) throw new WorkflowAbortError("stop");
        return prev;
      },
    ),
    /stop/,
  );
});
