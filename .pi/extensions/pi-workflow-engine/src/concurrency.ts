import { performance } from "node:perf_hooks";
import { abortReason, isFatalWorkflowError, throwIfAborted } from "./cancellation.ts";

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

export interface ParallelSettledOptions {
  readonly settled: true;
}

export interface ParallelSettledError {
  readonly name?: string;
  readonly message: string;
}

export type ParallelSettledResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ParallelSettledError };

export interface WorkflowParallel {
  <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  <T>(thunks: Array<() => Promise<T>>, options: ParallelSettledOptions): Promise<Array<ParallelSettledResult<T>>>;
}

export interface PipelineOptions {
  readonly signal?: AbortSignal;
  readonly abortController?: AbortController;
}

export function compactResults<T>(values: ReadonlyArray<T | null | undefined>): T[] {
  return values.filter((value): value is T => value != null);
}

/** Run every thunk concurrently and wait for all results; recoverable failures become null slots by default. */
export function parallel<T>(
  thunks: Array<() => Promise<T>>,
  options: ParallelOptions & ParallelSettledOptions,
): Promise<Array<ParallelSettledResult<T>>>;
export function parallel<T>(thunks: Array<() => Promise<T>>, options?: ParallelOptions): Promise<Array<T | null>>;
export async function parallel<T>(
  thunks: Array<() => Promise<T>>,
  options: ParallelOptions & Partial<ParallelSettledOptions> = {},
): Promise<Array<T | null> | Array<ParallelSettledResult<T>>> {
  if (options.settled) {
    return await runParallel(
      thunks,
      options,
      (value): ParallelSettledResult<T> => ({ ok: true, value }),
      (error): ParallelSettledResult<T> => ({ ok: false, error: serializeParallelError(error) }),
    );
  }

  return await runParallel(
    thunks,
    options,
    (value): T | null => value,
    (): T | null => null,
  );
}

export function bindParallel(options: ParallelOptions): WorkflowParallel {
  const executionOptions: ParallelOptions = {
    signal: options.signal,
    abortController: options.abortController,
    limit: options.limit,
  };

  function boundParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>;
  function boundParallel<T>(
    thunks: Array<() => Promise<T>>,
    workflowOptions: ParallelSettledOptions,
  ): Promise<Array<ParallelSettledResult<T>>>;
  async function boundParallel<T>(
    thunks: Array<() => Promise<T>>,
    workflowOptions?: ParallelSettledOptions,
  ): Promise<Array<T | null> | Array<ParallelSettledResult<T>>> {
    if (workflowOptions?.settled) {
      return await parallel(thunks, { ...executionOptions, settled: true });
    }
    return await parallel(thunks, executionOptions);
  }

  return boundParallel;
}

async function runParallel<T, Result>(
  thunks: Array<() => Promise<T>>,
  options: ParallelOptions,
  onSuccess: (value: T) => Result,
  onFailure: (error: unknown) => Result,
): Promise<Result[]> {
  throwIfAborted(options.signal);
  const results = new Array<Result>(thunks.length);
  let remaining = thunks.length;
  if (remaining === 0) return results;

  const limit = normalizeLimit(options.limit, thunks.length);
  return await new Promise<Result[]>((resolve, reject) => {
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
    const settleSlot = (index: number, value: Result) => {
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
            (value) => settleSlot(index, onSuccess(value)),
            (error: unknown) => {
              if (isFatalWorkflowError(error, options.signal)) {
                rejectOnce(error);
                return;
              }
              settleSlot(index, onFailure(error));
            },
          );
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    launchMore();
  });
}

function serializeParallelError(error: unknown): ParallelSettledError {
  if (error instanceof Error) {
    return error.name.length > 0 ? { name: error.name, message: error.message } : { message: error.message };
  }
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    const name = "name" in error && typeof error.name === "string" && error.name.length > 0 ? error.name : undefined;
    return name ? { name, message: error.message } : { message: error.message };
  }
  return { message: String(error) };
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
): Promise<Array<A | null>>;
export async function pipeline<Item, A, B>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
): Promise<Array<B | null>>;
export async function pipeline<Item, A, B, C>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
  stage3: (prev: B, item: Item, index: number) => Promise<C>,
): Promise<Array<C | null>>;
export async function pipeline(
  items: readonly unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
): Promise<Array<unknown | null>>;
export async function pipeline(
  items: readonly unknown[],
  ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
): Promise<Array<unknown | null>> {
  return pipelineWithOptions(items, stages);
}

export function bindPipeline(options: PipelineOptions): Pipeline {
  async function boundPipeline<Item, A>(
    items: readonly Item[],
    stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  ): Promise<Array<A | null>>;
  async function boundPipeline<Item, A, B>(
    items: readonly Item[],
    stage1: (prev: Item, item: Item, index: number) => Promise<A>,
    stage2: (prev: A, item: Item, index: number) => Promise<B>,
  ): Promise<Array<B | null>>;
  async function boundPipeline<Item, A, B, C>(
    items: readonly Item[],
    stage1: (prev: Item, item: Item, index: number) => Promise<A>,
    stage2: (prev: A, item: Item, index: number) => Promise<B>,
    stage3: (prev: B, item: Item, index: number) => Promise<C>,
  ): Promise<Array<C | null>>;
  async function boundPipeline(
    items: readonly unknown[],
    ...stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>
  ): Promise<Array<unknown | null>> {
    return pipelineWithOptions(items, stages, options);
  }
  return boundPipeline;
}

export async function pipelineWithOptions(
  items: readonly unknown[],
  stages: Array<(prev: unknown, item: unknown, index: number) => Promise<unknown>>,
  options: PipelineOptions = {},
): Promise<Array<unknown | null>> {
  throwIfAborted(options.signal);
  return Promise.all(
    items.map(async (item, index) => {
      throwIfAborted(options.signal);
      let acc: unknown = item;
      try {
        for (const stage of stages) {
          throwIfAborted(options.signal);
          acc = await stage(acc, item, index);
        }
        return acc;
      } catch (error) {
        if (isFatalWorkflowError(error, options.signal)) {
          options.abortController?.abort(error);
          throw error;
        }
        return null;
      }
    }),
  );
}

export type Pipeline = typeof pipeline;
