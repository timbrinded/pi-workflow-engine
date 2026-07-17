import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  RequiredFinalizerError,
  runFinalizers,
} from "../.pi/extensions/pi-workflow-engine/src/finalizers.ts";

test("runFinalizers executes every finalizer and reports best-effort failures without throwing", async () => {
  const calls: string[] = [];
  const reported: string[] = [];

  const failures = await runFinalizers(
    [
      {
        name: "first",
        criticality: "best-effort",
        run: () => {
          calls.push("first");
        },
      },
      {
        name: "observer",
        criticality: "best-effort",
        run: () => {
          calls.push("observer");
          throw new Error("observer failed");
        },
      },
      {
        name: "last",
        criticality: "required",
        run: () => {
          calls.push("last");
        },
      },
    ],
    { onBestEffortFailure: (failure) => reported.push(failure.name) },
  );

  assert.deepEqual(calls, ["first", "observer", "last"]);
  assert.deepEqual(reported, ["observer"]);
  assert.deepEqual(failures.map((failure) => failure.name), ["observer"]);
});

test("runFinalizers aggregates required failures after running every finalizer", async () => {
  const calls: string[] = [];
  const firstError = new Error("first failed");
  const secondError = new Error("second failed");
  let thrown: unknown;

  try {
    await runFinalizers([
      {
        name: "first required",
        criticality: "required",
        run: () => {
          calls.push("first");
          throw firstError;
        },
      },
      {
        name: "advisory",
        criticality: "best-effort",
        run: () => {
          calls.push("advisory");
          throw new Error("ignored");
        },
      },
      {
        name: "second required",
        criticality: "required",
        run: async () => {
          calls.push("second");
          throw secondError;
        },
      },
      {
        name: "last",
        criticality: "required",
        run: () => {
          calls.push("last");
        },
      },
    ]);
  } catch (error) {
    thrown = error;
  }

  assert.deepEqual(calls, ["first", "advisory", "second", "last"]);
  assert.ok(thrown instanceof RequiredFinalizerError);
  assert.deepEqual(thrown.errors, [firstError, secondError]);
  assert.deepEqual(thrown.failures.map((failure) => failure.name), ["first required", "second required"]);
  assert.match(thrown.message, /first required \(first failed\), second required \(second failed\)/);
});

test("runFinalizers ignores failures from the best-effort failure observer", async () => {
  const failures = await runFinalizers(
    [
      {
        name: "advisory",
        criticality: "best-effort",
        run: () => {
          throw new Error("advisory failed");
        },
      },
    ],
    {
      onBestEffortFailure() {
        throw new Error("observer failed");
      },
    },
  );

  assert.deepEqual(failures.map((failure) => failure.name), ["advisory"]);
});
