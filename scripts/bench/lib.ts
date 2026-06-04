import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

export interface BenchCliOptions {
  readonly json: boolean;
  readonly iterations: number;
  readonly out: string | undefined;
  readonly flags: ReadonlyMap<string, string>;
}

export interface BenchmarkStats {
  readonly name: string;
  readonly iterations: number;
  readonly min: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export function parseBenchArgs(argv: readonly string[] = process.argv.slice(2)): BenchCliOptions {
  const flags = new Map<string, string>();
  let json = false;
  let iterations = 1;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--out") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out = next;
        i++;
      } else {
        out = "auto";
      }
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length) || "auto";
      continue;
    }
    if (arg === "--iterations") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        iterations = parsePositiveInt(next, iterations);
        i++;
      }
      continue;
    }
    if (arg.startsWith("--iterations=")) {
      iterations = parsePositiveInt(arg.slice("--iterations=".length), iterations);
      continue;
    }
    if (!arg.startsWith("--")) continue;

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(arg.slice(2), next);
      i++;
    } else {
      flags.set(arg.slice(2), "true");
    }
  }

  return { json, iterations, out, flags };
}

export function numberFlag(options: BenchCliOptions, name: string, defaultValue: number): number {
  const raw = options.flags.get(name);
  if (raw === undefined) return defaultValue;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export function intFlag(options: BenchCliOptions, name: string, defaultValue: number): number {
  return Math.max(1, Math.trunc(numberFlag(options, name, defaultValue)));
}

export async function runBenchmark(name: string, iterations: number, fn: () => Promise<void> | void): Promise<BenchmarkStats> {
  const durations: number[] = [];
  for (let i = 0; i < Math.max(1, iterations); i++) {
    const start = performance.now();
    await fn();
    durations.push(performance.now() - start);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    name,
    iterations: sorted.length,
    min: sorted[0] ?? 0,
    mean: sorted.length === 0 ? 0 : total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

export async function maybeWriteBenchmarkOutput(name: string, data: unknown, out: string | undefined): Promise<string | undefined> {
  if (!out) return undefined;
  const path = out === "auto" ? join(".artifacts", "benchmarks", `${timestamp()}-${safeName(name)}.json`) : out;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
  return path;
}

export function printBenchmarkOutput(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}

function parsePositiveInt(raw: string, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * p) - 1));
  return sortedValues[index] ?? 0;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
