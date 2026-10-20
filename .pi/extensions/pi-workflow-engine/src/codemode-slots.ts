import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Semaphore } from "./concurrency.ts";

/**
 * pi runs at most this many codemode scripts per process, and rejects one more with "Codemode worker
 * limit reached" instead of waiting (pi 1.3 `extensions/codemode/execute.js`). Every subagent shares
 * that limit with the others and with the host, so a fan-out of codemode agents would fail calls.
 */
export const CODEMODE_WORKER_SLOTS = 2;

const processSlots = new Semaphore(CODEMODE_WORKER_SLOTS);

/**
 * Queue a subagent's top-level calls to `toolName` for one of the process-wide codemode slots, so a
 * call waits for a running script instead of failing. pi frees its own slot only once the worker has
 * exited, which can lag the result on Bun, so a call can still meet pi's limit now and then. The host's
 * own codemode calls are not queued.
 */
export function createCodemodeSlotExtension(toolName: string, slots: Semaphore = processSlots): ExtensionFactory {
  return (pi) => {
    const held = new Map<string, () => void>();
    const release = (toolCallId: string): void => {
      held.get(toolCallId)?.();
      held.delete(toolCallId);
    };
    // A call another handler blocks after this one took a slot never runs, so the turn's end frees it.
    const releaseAll = (): void => {
      for (const toolCallId of [...held.keys()]) release(toolCallId);
    };

    pi.on("tool_call", async (event, ctx) => {
      // A script's nested calls run inside the slot its own call holds.
      if (event.toolName !== toolName || event.parentToolCallId !== undefined) return undefined;
      // Rejects while queued once the agent is aborted; pi then blocks the call.
      await new Promise<void>((acquired, failed) => {
        slots
          .run(
            () =>
              new Promise<void>((done) => {
                held.set(event.toolCallId, done);
                acquired();
              }),
            { signal: ctx.signal },
          )
          .catch(failed);
      });
      return undefined;
    });
    pi.on("tool_execution_end", (event) => release(event.toolCallId));
    pi.on("tool_result", (event) => {
      release(event.toolCallId);
      return undefined;
    });
    pi.on("turn_end", () => {
      releaseAll();
      return undefined;
    });
    pi.on("session_shutdown", releaseAll);
  };
}
