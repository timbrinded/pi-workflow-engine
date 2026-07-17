import { performance } from "node:perf_hooks";
import { abortReason, isFatalWorkflowError, throwIfAborted } from "./cancellation.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

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
  /** Maximum time to drain already-started tasks after a fatal failure. */
  readonly drainTimeoutMs?: number;
}

export interface ParallelSettledOptions {
  readonly settled: true;
}

export interface ParallelSettledError {
  readonly name?: string;
  readonly message: string;
  readonly code?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
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
  /** Maximum time to drain already-started item chains after a fatal failure. */
  readonly drainTimeoutMs?: number;
}

const DEFAULT_FATAL_DRAIN_TIMEOUT_MS = 1_000;

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
    drainTimeoutMs: options.drainTimeoutMs,
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
  if (thunks.length === 0) return results;

  const limit = normalizeLimit(options.limit, thunks.length);
  return await new Promise<Result[]>((resolve, reject) => {
    let terminal = false;
    let nextIndex = 0;
    let workersRemaining = limit;
    let fatalFailure: { readonly error: unknown } | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (drainTimer) clearTimeout(drainTimer);
    };
    const settle = (force = false) => {
      if (terminal || (!force && workersRemaining > 0)) return;
      terminal = true;
      cleanup();
      if (fatalFailure) reject(fatalFailure.error);
      else resolve(results);
    };
    const recordFatalFailure = (error: unknown) => {
      if (fatalFailure) return;
      fatalFailure = { error };
      options.abortController?.abort(error);
      const timeoutMs = normalizeDrainTimeout(options.drainTimeoutMs);
      drainTimer = setTimeout(() => settle(true), timeoutMs);
    };
    const completeWorker = () => {
      workersRemaining--;
      settle();
    };
    const onAbort = () => recordFatalFailure(abortReason(options.signal));
    const runWorker = async () => {
      while (!fatalFailure) {
        throwIfAborted(options.signal);
        const index = nextIndex++;
        if (index >= thunks.length) return;
        try {
          const value = await thunks[index]();
          if (fatalFailure) return;
          results[index] = onSuccess(value);
        } catch (error) {
          if (fatalFailure) return;
          if (isFatalWorkflowError(error, options.signal)) {
            recordFatalFailure(error);
            return;
          }
          results[index] = onFailure(error);
        }
      }
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    for (let worker = 0; worker < limit; worker++) {
      void runWorker().then(completeWorker, (error) => {
        recordFatalFailure(error);
        completeWorker();
      });
    }
  });
}

function serializeParallelError(error: unknown): ParallelSettledError {
  const message = readStringProperty(error, "message") ?? unknownErrorMessage(error);
  const name = readStringProperty(error, "name");
  const code = readStringProperty(error, "code");
  const details = readSerializableDetails(error);
  return {
    ...(name && name.length > 0 ? { name } : {}),
    message,
    ...(code && code.length > 0 ? { code } : {}),
    ...(details ? { details } : {}),
  };
}

function readStringProperty(value: unknown, property: "message" | "name" | "code"): string | undefined {
  const candidate = readProperty(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

function readSerializableDetails(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  const candidate = readProperty(value, "details");
  if (typeof candidate !== "object" || candidate === null) return undefined;
  try {
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, detail] of Object.entries(candidate)) {
      if (
        typeof detail === "string" ||
        typeof detail === "boolean" ||
        detail === null ||
        (typeof detail === "number" && Number.isFinite(detail))
      ) {
        details[key] = detail;
      }
    }
    return Object.keys(details).length > 0 ? details : undefined;
  } catch {
    return undefined;
  }
}

function readProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return undefined;
  try {
    return Reflect.get(value, property);
  } catch {
    return undefined;
  }
}

function normalizeLimit(limit: number | undefined, itemCount: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return Math.max(1, itemCount);
  return Math.max(1, Math.min(itemCount, Math.trunc(limit)));
}

function normalizeDrainTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_FATAL_DRAIN_TIMEOUT_MS;
  return Math.max(0, Math.trunc(timeoutMs));
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
export async function pipeline<Item, A, B, C, D>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
  stage3: (prev: B, item: Item, index: number) => Promise<C>,
  stage4: (prev: C, item: Item, index: number) => Promise<D>,
): Promise<Array<D | null>>;
export async function pipeline<Item, A, B, C, D, E>(
  items: readonly Item[],
  stage1: (prev: Item, item: Item, index: number) => Promise<A>,
  stage2: (prev: A, item: Item, index: number) => Promise<B>,
  stage3: (prev: B, item: Item, index: number) => Promise<C>,
  stage4: (prev: C, item: Item, index: number) => Promise<D>,
  stage5: (prev: D, item: Item, index: number) => Promise<E>,
): Promise<Array<E | null>>;
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
  async function boundPipeline<Item, A, B, C, D>(
    items: readonly Item[],
    stage1: (prev: Item, item: Item, index: number) => Promise<A>,
    stage2: (prev: A, item: Item, index: number) => Promise<B>,
    stage3: (prev: B, item: Item, index: number) => Promise<C>,
    stage4: (prev: C, item: Item, index: number) => Promise<D>,
  ): Promise<Array<D | null>>;
  async function boundPipeline<Item, A, B, C, D, E>(
    items: readonly Item[],
    stage1: (prev: Item, item: Item, index: number) => Promise<A>,
    stage2: (prev: A, item: Item, index: number) => Promise<B>,
    stage3: (prev: B, item: Item, index: number) => Promise<C>,
    stage4: (prev: C, item: Item, index: number) => Promise<D>,
    stage5: (prev: D, item: Item, index: number) => Promise<E>,
  ): Promise<Array<E | null>>;
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
  return await parallel(
    items.map((item, index) => async () => {
      throwIfAborted(options.signal);
      let acc: unknown = item;
      for (const stage of stages) {
        throwIfAborted(options.signal);
        acc = await stage(acc, item, index);
      }
      return acc;
    }),
    options,
  );
}

export type Pipeline = typeof pipeline;
