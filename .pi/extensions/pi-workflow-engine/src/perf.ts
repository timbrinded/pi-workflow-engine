import { performance } from "node:perf_hooks";

export interface PerfAggregate {
  readonly name: string;
  readonly count: number;
  readonly total: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

export interface PerfSnapshot {
  readonly enabled: boolean;
  readonly aggregates: readonly PerfAggregate[];
}

export interface PerfSink {
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;
  timeSync<T>(name: string, fn: () => T): T;
  observe(name: string, value: number): void;
  counter(name: string, delta?: number): void;
  snapshot(): PerfSnapshot;
}

export class PerfRecorder implements PerfSink {
  /** Finite observed values per metric, in first-observation order. */
  private readonly values = new Map<string, number[]>();

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }

  timeSync<T>(name: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.observe(name, performance.now() - start);
    }
  }

  observe(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    const values = this.values.get(name);
    if (values) values.push(value);
    else this.values.set(name, [value]);
  }

  counter(name: string, delta = 1): void {
    this.observe(name, delta);
  }

  snapshot(): PerfSnapshot {
    return { enabled: true, aggregates: [...this.values].map(([name, values]) => aggregate(name, values)) };
  }
}

export class NoopPerfRecorder implements PerfSink {
  async time<T>(_name: string, fn: () => Promise<T>): Promise<T> {
    return await fn();
  }

  timeSync<T>(_name: string, fn: () => T): T {
    return fn();
  }

  observe(): void {}

  counter(): void {}

  snapshot(): PerfSnapshot {
    return { enabled: false, aggregates: [] };
  }
}

export function createPerfRecorder(enabled: boolean): PerfSink {
  return enabled ? new PerfRecorder() : new NoopPerfRecorder();
}

export function formatPerfSummary(aggregates: readonly PerfAggregate[]): string {
  const parts = aggregates.slice(0, 4).map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `Perf: ${parts.join(" · ")}` : "Perf: no samples";
}

/** `observed` is never empty: a metric is recorded with its first value. */
function aggregate(name: string, observed: readonly number[]): PerfAggregate {
  const values = [...observed].sort((a, b) => a - b);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    name,
    count: values.length,
    total,
    min: values[0],
    max: values[values.length - 1],
    mean: total / values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

function percentile(sortedValues: readonly number[], p: number): number {
  return sortedValues[Math.ceil(sortedValues.length * p) - 1];
}
