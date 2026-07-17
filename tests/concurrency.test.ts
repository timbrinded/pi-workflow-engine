import assert from "node:assert/strict";
import { test } from "bun:test";
import { WorkflowBudgetExceededError } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { bindParallel, parallel, pipeline, pipelineWithOptions, Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";

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

test("parallel settled mode preserves order and distinguishes null values from failures", async () => {
  const results = await parallel(
    [
      async () => {
        await delay(8);
        return "first";
      },
      async () => null,
      async () => {
        await delay(1);
        const error = new Error("boom");
        error.name = "ExpectedError";
        throw error;
      },
      async () => {
        throw "plain failure";
      },
    ],
    { settled: true },
  );

  assert.deepEqual(results, [
    { ok: true, value: "first" },
    { ok: true, value: null },
    { ok: false, error: { name: "ExpectedError", message: "boom" } },
    { ok: false, error: { message: "plain failure" } },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), results);
});

test("parallel settled mode serializes hostile thrown values without hanging", async () => {
  const hostileError = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "message" || property === Symbol.toPrimitive) throw new Error("serialization trap");
        return undefined;
      },
    },
  );

  const outcome = await Promise.race([
    parallel(
      [
        async () => {
          throw hostileError;
        },
      ],
      { settled: true },
    ),
    delay(500).then(() => "pending" as const),
  ]);

  assert.notEqual(outcome, "pending");
  assert.deepEqual(outcome, [{ ok: false, error: { message: "unknown error" } }]);
});

test("parallel does not submit queued work after a fatal failure", async () => {
  const started: number[] = [];

  await assert.rejects(
    parallel(
      [0, 1, 2].map((index) => async () => {
        started.push(index);
        if (index === 0) throw new WorkflowAbortError("fatal first task");
        return index;
      }),
      { limit: 1 },
    ),
    /fatal first task/,
  );

  assert.deepEqual(started, [0]);
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

test("parallel settles when an abort reason has hostile prototype traps", async () => {
  const controller = new AbortController();
  const hostileReason = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("prototype trap");
    },
  });
  const running = parallel(
    [
      async () => await new Promise<never>(() => undefined),
    ],
    { signal: controller.signal, drainTimeoutMs: 10 },
  );

  controller.abort(hostileReason);
  const outcome = await Promise.race([
    running.then(
      () => "resolved" as const,
      (error: unknown) => error,
    ),
    delay(500).then(() => "pending" as const),
  ]);

  assert.notEqual(outcome, "pending");
  assert.notEqual(outcome, "resolved");
  assert.ok(outcome instanceof WorkflowAbortError);
});

test("parallel settled mode still rejects on run abort", async () => {
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
    { signal: controller.signal, settled: true },
  );

  controller.abort(new WorkflowAbortError("stop settled"));

  await assert.rejects(running, /stop settled/);
});

test("parallel settled mode aborts siblings when a thunk fails fatally", async () => {
  const controller = new AbortController();
  let siblingAborted = false;
  const running = parallel(
    [
      async () => {
        await delay(2);
        throw new WorkflowAbortError("fatal settled thunk");
      },
      async () =>
        await new Promise<string>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              siblingAborted = true;
              reject(controller.signal.reason);
            },
            { once: true },
          );
        }),
    ],
    { signal: controller.signal, abortController: controller, settled: true },
  );

  await assert.rejects(running, /fatal settled thunk/);
  assert.equal(siblingAborted, true);
});

test("parallel drains cooperative siblings before rejecting a fatal failure", async () => {
  const controller = new AbortController();
  let siblingUnwound = false;
  const running = parallel(
    [
      async () => {
        await delay(1);
        throw new WorkflowAbortError("fatal with drain");
      },
      async () => {
        try {
          await delay(20);
          return "late";
        } finally {
          await delay(5);
          siblingUnwound = true;
        }
      },
    ],
    { signal: controller.signal, abortController: controller },
  );

  await assert.rejects(running, /fatal with drain/);
  assert.equal(siblingUnwound, true);
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

test("parallel settled mode retains budget exhaustion details", async () => {
  const results = await parallel(
    [
      async () => 1,
      async () => {
        throw new WorkflowBudgetExceededError(10, 12);
      },
    ],
    { settled: true },
  );

  assert.deepEqual(results, [
    { ok: true, value: 1 },
    {
      ok: false,
      error: {
        name: "WorkflowBudgetExceededError",
        message: "Workflow token budget exhausted: spent 12 output tokens of 10.",
      },
    },
  ]);
});

test("bound parallel keeps the engine submission limit when workflow options contain extra keys", async () => {
  const internalController = new AbortController();
  const workflowController = new AbortController();
  const bound = bindParallel({
    signal: internalController.signal,
    abortController: internalController,
    limit: 1,
  });
  const workflowOptions = {
    settled: true as const,
    signal: workflowController.signal,
    abortController: workflowController,
    limit: 10,
  };
  let active = 0;
  let maxActive = 0;

  const results = await bound(
    [0, 1, 2].map((value) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(2);
      active--;
      return value;
    }),
    workflowOptions,
  );

  assert.equal(maxActive, 1);
  assert.deepEqual(results, [
    { ok: true, value: 0 },
    { ok: true, value: 1 },
    { ok: true, value: 2 },
  ]);
  assert.equal(workflowController.signal.aborted, false);
});

test("bound parallel keeps the engine abort signal when workflow options contain extra keys", async () => {
  const internalController = new AbortController();
  const workflowController = new AbortController();
  const bound = bindParallel({
    signal: internalController.signal,
    abortController: internalController,
    limit: 1,
  });
  const workflowOptions = {
    settled: true as const,
    signal: workflowController.signal,
    abortController: workflowController,
    limit: 10,
  };
  internalController.abort(new WorkflowAbortError("internal stop"));

  await assert.rejects(bound([async () => "unreachable"], workflowOptions), /internal stop/);
  assert.equal(workflowController.signal.aborted, false);
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

test("pipeline preserves the abort reason when a stage throws afterward", async () => {
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
    /stop/,
  );
});

test("pipeline aborts sibling item chains after a fatal failure", async () => {
  const controller = new AbortController();
  let siblingStage2Ran = false;
  let siblingUnwound = false;

  const running = pipelineWithOptions(
    [1, 2],
    [
      async (_prev, item) => {
        if (item === 1) {
          await delay(1);
          throw new WorkflowAbortError("fatal");
        }
        try {
          await delay(10);
          return item;
        } finally {
          await delay(5);
          siblingUnwound = true;
        }
      },
      async (prev) => {
        siblingStage2Ran = true;
        return prev;
      },
    ],
    { signal: controller.signal, abortController: controller },
  );

  await assert.rejects(running, /fatal/);
  assert.equal(controller.signal.aborted, true);
  assert.equal(siblingStage2Ran, false);
  assert.equal(siblingUnwound, true);
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
