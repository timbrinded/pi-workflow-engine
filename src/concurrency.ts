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

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

/** Run every thunk concurrently and wait for all results (a barrier). */
export async function parallel<T>(thunks: Array<() => Promise<T>>): Promise<T[]> {
  return Promise.all(thunks.map((thunk) => thunk()));
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
