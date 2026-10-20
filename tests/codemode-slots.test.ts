import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCodemodeSlotExtension } from "../.pi/extensions/pi-workflow-engine/src/codemode-slots.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

/** One subagent session's view of the queue: its handlers, driven with pi-shaped events. */
function session(slots: Semaphore, signal?: AbortSignal) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (event: string, handler: Handler) => handlers.set(event, handler) } as unknown as ExtensionAPI;
  void createCodemodeSlotExtension("codemode", slots)(pi);
  const ctx = { signal } as ExtensionContext;
  const emit = (event: string, payload: Record<string, unknown>) => handlers.get(event)?.({ type: event, ...payload }, ctx);
  return {
    call: (toolCallId: string, extra: Record<string, unknown> = {}) =>
      Promise.resolve(emit("tool_call", { toolCallId, toolName: "codemode", input: {}, ...extra })),
    end: (toolCallId: string) => emit("tool_execution_end", { toolCallId, toolName: "codemode", result: {}, isError: false }),
    turnEnd: () => emit("turn_end", {}),
  };
}

function settledFlag(promise: Promise<unknown>): () => boolean {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  return () => settled;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a third codemode call across sessions waits for a running script instead of failing", async () => {
  const slots = new Semaphore(2);
  const [a, b, c] = [session(slots), session(slots), session(slots)];
  await a.call("a1");
  await b.call("b1");
  const third = c.call("c1");
  const started = settledFlag(third);
  await tick();
  assert.equal(started(), false, "pi allows two live codemode workers, so the third call queues");

  a.end("a1");
  await third;
  assert.equal(started(), true);
});

test("nested calls and other tools pass through without a slot", async () => {
  const slots = new Semaphore(1);
  const agent = session(slots);
  await agent.call("script");
  await agent.call("script/1", { parentToolCallId: "script" });
  await agent.call("read-1", { toolName: "read" });
});

test("an aborted agent stops waiting and pi blocks its queued call", async () => {
  const slots = new Semaphore(1);
  const controller = new AbortController();
  await session(slots).call("holder");
  const queued = session(slots, controller.signal).call("queued");
  controller.abort(new Error("agent aborted"));
  await assert.rejects(queued, /agent aborted/);
});

test("a slot held by a call that never ran is freed when its turn ends", async () => {
  const slots = new Semaphore(1);
  const blocked = session(slots);
  await blocked.call("blocked-by-a-later-handler");
  const next = session(slots).call("next");
  const started = settledFlag(next);
  await tick();
  assert.equal(started(), false);

  blocked.turnEnd();
  await next;
});
