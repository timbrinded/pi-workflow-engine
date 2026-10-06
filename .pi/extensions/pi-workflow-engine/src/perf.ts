import { performance } from "node:perf_hooks";

export type PerfTags = Record<string, string | number>;

export interface PerfSample {
  readonly name: string;
  readonly durationMs?: number;
  readonly value?: number;
  readonly tags?: PerfTags;
}

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
  readonly startedAt: number;
  readonly samples: readonly PerfSample[];
  readonly aggregates: readonly PerfAggregate[];
}

export interface PerfSink {
  time<T>(name: string, fn: () => Promise<T>, tags?: PerfTags): Promise<T>;
  timeSync<T>(name: string, fn: () => T, tags?: PerfTags): T;
  observe(name: string, value: number, tags?: PerfTags): void;
  counter(name: string, delta?: number, tags?: PerfTags): void;
  snapshot(): PerfSnapshot;
}

export class PerfRecorder implements PerfSink {
  private readonly samples: PerfSample[] = [];

  constructor(private readonly startedAt = Date.now()) {}

  async time<T>(name: string, fn: () => Promise<T>, tags?: PerfTags): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.observeDuration(name, performance.now() - start, tags);
    }
  }

  timeSync<T>(name: string, fn: () => T, tags?: PerfTags): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.observeDuration(name, performance.now() - start, tags);
    }
  }

  observe(name: string, value: number, tags?: PerfTags): void {
    if (!Number.isFinite(value)) return;
    this.samples.push({ name, value, tags });
  }

  counter(name: string, delta = 1, tags?: PerfTags): void {
    this.observe(name, delta, tags);
  }

  snapshot(): PerfSnapshot {
    return {
      enabled: true,
      startedAt: this.startedAt,
      samples: this.samples.map((sample) => ({ ...sample, tags: sample.tags ? { ...sample.tags } : undefined })),
      aggregates: aggregateSamples(this.samples),
    };
  }

  private observeDuration(name: string, durationMs: number, tags?: PerfTags): void {
    if (!Number.isFinite(durationMs)) return;
    this.samples.push({ name, durationMs, tags });
  }
}

export class NoopPerfRecorder implements PerfSink {
  constructor(private readonly startedAt = Date.now()) {}

  async time<T>(_name: string, fn: () => Promise<T>, _tags?: PerfTags): Promise<T> {
    return await fn();
  }

  timeSync<T>(_name: string, fn: () => T, _tags?: PerfTags): T {
    return fn();
  }

  observe(_name: string, _value: number, _tags?: PerfTags): void {}

  counter(_name: string, _delta?: number, _tags?: PerfTags): void {}

  snapshot(): PerfSnapshot {
    return { enabled: false, startedAt: this.startedAt, samples: [], aggregates: [] };
  }
}

export function createPerfRecorder(enabled: boolean, startedAt?: number): PerfSink {
  return enabled ? new PerfRecorder(startedAt) : new NoopPerfRecorder(startedAt);
}

export function formatPerfSummary(aggregates: readonly PerfAggregate[]): string {
  const parts = aggregates.slice(0, 4).map((aggregate) => `${aggregate.name} ${Math.round(aggregate.total)}ms`);
  return parts.length > 0 ? `Perf: ${parts.join(" · ")}` : "Perf: no samples";
}

function aggregateSamples(samples: readonly PerfSample[]): PerfAggregate[] {
  const byName = new Map<string, number[]>();
  for (const sample of samples) {
    const value = sample.durationMs ?? sample.value;
    if (value === undefined || !Number.isFinite(value)) continue;
    const values = byName.get(sample.name) ?? [];
    values.push(value);
    byName.set(sample.name, values);
  }

  return [...byName.entries()].map(([name, rawValues]) => {
    const values = [...rawValues].sort((a, b) => a - b);
    const total = values.reduce((sum, value) => sum + value, 0);
    return {
      name,
      count: values.length,
      total,
      min: values[0] ?? 0,
      max: values[values.length - 1] ?? 0,
      mean: values.length === 0 ? 0 : total / values.length,
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
    };
  });
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index] ?? 0;
}
