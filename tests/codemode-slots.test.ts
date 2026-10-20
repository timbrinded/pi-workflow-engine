import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCodemodeSlotExtension, runToolCallsSequentially } from "../.pi/extensions/pi-workflow-engine/src/codemode-slots.ts";
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

/**
 * A real pi session whose model sends three codemode calls in one message, then answers. Its codemode
 * tool records each call it runs; the calls queue for two slots, like pi's worker limit.
 */
async function threeCodemodeCallsInOneMessage(configure: (session: AgentSession) => void) {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-codemode-slots-"));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const executed: string[] = [];
  const codemode: ExtensionFactory = (pi) => {
    pi.registerTool({
      name: "codemode",
      label: "Codemode",
      description: "Run a script.",
      parameters: Type.Object({ code: Type.String() }),
      async execute(toolCallId) {
        executed.push(toolCallId);
        return { content: [{ type: "text", text: "1" }], details: {} };
      },
    });
  };
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: SettingsManager.inMemory(),
    modelRuntime,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [codemode, createCodemodeSlotExtension("codemode", new Semaphore(2))],
    },
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(root),
    model: faux.getModel(),
    tools: ["codemode"],
  });
  configure(session);
  const calls = ["script-1", "script-2", "script-3"];
  faux.setResponses([
    fauxAssistantMessage(calls.map((id) => fauxToolCall("codemode", { code: "return 1" }, { id })), { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  const run = session.prompt("Run the scripts.");
  return {
    calls,
    executed,
    session,
    finishedWithin: (ms: number) =>
      Promise.race([run.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]),
    async close() {
      await session.abort();
      await run.catch(() => undefined);
      session.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a codemode agent runs more codemode calls from one message than there are slots", async () => {
  const agent = await threeCodemodeCallsInOneMessage(runToolCallsSequentially);
  try {
    assert.equal(await agent.finishedWithin(5_000), true);
    assert.deepEqual(agent.executed, agent.calls);
    assert.equal(agent.session.getLastAssistantText(), "done");
  } finally {
    await agent.close();
  }
});

test("under pi's default parallel tool execution those calls deadlock in tool_call", async () => {
  // pi runs every call's tool_call hook before executing any: two calls hold both slots and cannot run
  // while the third waits for one of them.
  const agent = await threeCodemodeCallsInOneMessage(() => undefined);
  try {
    assert.equal(await agent.finishedWithin(300), false);
    assert.deepEqual(agent.executed, []);
  } finally {
    await agent.close();
  }
});
