import { performance } from "node:perf_hooks";
import { abortReason, throwIfAborted } from "./cancellation.ts";

/**
 * A counting semaphore: bounds how many async tasks run at once.
 *
 * This is the single global concurrency cap for a workflow run. Every `agent()`
 * call acquires a slot before spawning a session and releases it when done, so the
 * cap holds no matter how `parallel`/`pipeline` are nested — exactly like the
 * built-in Workflow tool, where "concurrent agent() calls are capped and excess queue".
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, options: { onQueueWaitMs?: (durationMs: number) => void; signal?: AbortSignal } = {}): Promise<T> {
    throwIfAborted(options.signal);
    const queuedAt = performance.now();
    if (this.active >= this.max) {
      await this.waitForSlot(options.signal);
    }
    options.onQueueWaitMs?.(performance.now() - queuedAt);
    throwIfAborted(options.signal);
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private async waitForSlot(signal: AbortSignal | undefined): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
      };
      const waiter = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        cleanup();
        reject(abortReason(signal));
      };
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      this.waiters.push(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export interface ParallelOptions {
  readonly signal?: AbortSignal;
  readonly abortController?: AbortController;
  readonly limit?: number;
}

/** Run every thunk concurrently and wait for all results (a barrier). */
export async function parallel<T>(thunks: Array<() => Promise<T>>, options: ParallelOptions = {}): Promise<T[]> {
  throwIfAborted(options.signal);
  const results = new Array<T>(thunks.length);
  let remaining = thunks.length;
  if (remaining === 0) return results;

  const limit = normalizeLimit(options.limit, thunks.length);
  return await new Promise<T[]>((resolve, reject) => {
    let rejected = false;
    let active = 0;
    let next = 0;
    const cleanup = () => options.signal?.removeEventListener("abort", onAbort);
    const rejectOnce = (error: unknown) => {
      if (rejected) return;
      rejected = true;
      options.abortController?.abort(error);
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(abortReason(options.signal));
    const launchMore = () => {
      while (!rejected && active < limit && next < thunks.length) {
        const index = next++;
        active++;
        void Promise.resolve()
          .then(() => {
            throwIfAborted(options.signal);
            return thunks[index]();
          })
          .then(
            (value) => {
              if (rejected) return;
              active--;
              results[index] = value;
              remaining--;
              if (remaining === 0) {
                cleanup();
                resolve(results);
                return;
              }
              launchMore();
            },
            (error: unknown) => rejectOnce(error),
          );
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    launchMore();
  });
}

function normalizeLimit(limit: number | undefined, itemCount: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return Math.max(1, itemCount);
  return Math.max(1, Math.min(itemCount, Math.trunc(limit)));
}

/**
 * Run each item through all stages independently. There is NO barrier between
 * stages: item A can be in stage 3 while item B is still in stage 1. Actual agent
 * concurrency is bounded by the run's Semaphore (inside each `agent()`), not here —
 * so launching every item at once is safe.
 *
 * Each stage receives (previousResult, originalItem, index).
 */
export async function pipeline<Item, A>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
): Promise<A[]>;
export async function pipeline<Item, A, B>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
): Promise<B[]>;
export async function pipeline<Item, A, B, C>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
  stage3: (prev: B, item: Item, index: number) => Promise<C>,
): Promise<C[]>;
export async function pipeline(
  items: readonly unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
): Promise<unknown[]>;
export async function pipeline(
  items: readonly unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
): Promise<unknown[]> {
  return Promise.all(
    items.map(async (item, index) => {
      let acc: unknown = item;
      for (const stage of stages) {
        acc = await stage(acc, item, index);
      }
      return acc;
    }),
  );
}

export type Pipeline = typeof pipeline;
