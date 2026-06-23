import { cpus } from "node:os";
import type { WorkflowRunOptions } from "./types.ts";

export const WORKFLOW_BUDGET_MIN = 1;
export const WORKFLOW_BUDGET_MAX = 1_000_000_000;

export interface ResolvedWorkflowRunOptions extends WorkflowRunOptions {
  readonly perf: boolean;
  readonly concurrency: number;
  readonly parallelSubmissionLimit?: number;
  readonly budget?: number;
}

export function defaultConcurrency(cpuCount = cpus().length): number {
  return Math.min(8, Math.max(2, cpuCount));
}

export function resolveWorkflowRunOptions(
  input: WorkflowRunOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedWorkflowRunOptions {
  const concurrency = clampInteger(input.concurrency ?? parseInteger(env.PI_WORKFLOW_CONCURRENCY), 1, 64, defaultConcurrency());
  const parallelSubmissionLimit = optionalClampedInteger(
    input.parallelSubmissionLimit ?? parseInteger(env.PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT),
    1,
    10_000,
  );
  const budget = resolveBudget(input.budget, env.PI_WORKFLOW_BUDGET);
  return {
    ...input,
    perf: input.perf ?? env.PI_WORKFLOW_PERF === "1",
    concurrency,
    parallelSubmissionLimit,
    budget,
  };
}

function optionalClampedInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max, value);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

function resolveBudget(inputBudget: number | undefined, envBudget: string | undefined): number | undefined {
  if (inputBudget !== undefined) return normalizeExplicitBudget(inputBudget);
  return envBudget === undefined ? undefined : parseWorkflowBudgetString(envBudget);
}

function normalizeExplicitBudget(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < WORKFLOW_BUDGET_MIN || value > WORKFLOW_BUDGET_MAX) {
    throw new RangeError(`Workflow budget must be an integer between ${WORKFLOW_BUDGET_MIN} and ${WORKFLOW_BUDGET_MAX}.`);
  }
  return value;
}

export function parseWorkflowBudgetString(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < WORKFLOW_BUDGET_MIN || parsed > WORKFLOW_BUDGET_MAX) return undefined;
  return parsed;
}
