import { cpus } from "node:os";
import type { WorkflowRunOptions } from "./types.ts";

export const WORKFLOW_BUDGET_MIN = 1;
export const WORKFLOW_BUDGET_MAX = 1_000_000_000;
export const WORKFLOW_MAX_AGENTS_MIN = 1;
export const WORKFLOW_MAX_AGENTS_MAX = 10_000;
export const DEFAULT_WORKFLOW_MAX_AGENTS = 64;
export const WORKFLOW_AGENT_TIMEOUT_MIN_MS = 1_000;
export const WORKFLOW_AGENT_TIMEOUT_MAX_MS = 86_400_000;
export const DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS = 1_800_000;
export const WORKFLOW_AGENT_RETRIES_MIN = 0;
export const WORKFLOW_AGENT_RETRIES_MAX = 10;
export const DEFAULT_WORKFLOW_AGENT_RETRIES = 0;
export const WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN = 1;
export const WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX = 10;
export const DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS = 3;
export const WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS = 5_000;
export const WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS = 86_400_000;
export const DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS = 21_600_000;

export type ResolvedWorkflowRunOptions = Omit<
  WorkflowRunOptions,
  | "perf"
  | "concurrency"
  | "parallelSubmissionLimit"
  | "maxAgents"
  | "agentTimeoutMs"
  | "agentRetries"
  | "autoResumeOnUsageLimit"
  | "usageLimitMaxAttempts"
  | "usageLimitMaxDelayMs"
  | "usageLimitAttempt"
  | "resumeEditedWorkflow"
  | "budget"
> & {
  readonly perf: boolean;
  readonly concurrency: number;
  readonly parallelSubmissionLimit: number | null;
  readonly maxAgents: number;
  readonly agentTimeoutMs: number;
  readonly agentRetries: number;
  readonly autoResumeOnUsageLimit: boolean;
  readonly usageLimitMaxAttempts: number;
  readonly usageLimitMaxDelayMs: number;
  readonly usageLimitAttempt: number;
  readonly resumeEditedWorkflow: boolean;
  readonly budget: number | null;
};

export function defaultConcurrency(cpuCount = cpus().length): number {
  return Math.min(8, Math.max(2, cpuCount));
}

export function resolveWorkflowRunOptions(
  input: WorkflowRunOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedWorkflowRunOptions {
  const concurrency = clampInteger(input.concurrency ?? parseWorkflowIntegerString(env.PI_WORKFLOW_CONCURRENCY), 1, 64, defaultConcurrency());
  const parallelSubmissionLimit = optionalClampedInteger(
    input.parallelSubmissionLimit ?? parseWorkflowIntegerString(env.PI_WORKFLOW_PARALLEL_SUBMISSION_LIMIT),
    1,
    10_000,
  );
  const maxAgents = clampInteger(
    input.maxAgents ?? parseWorkflowIntegerString(env.PI_WORKFLOW_MAX_AGENTS),
    WORKFLOW_MAX_AGENTS_MIN,
    WORKFLOW_MAX_AGENTS_MAX,
    DEFAULT_WORKFLOW_MAX_AGENTS,
  );
  const agentTimeoutMs = clampInteger(
    input.agentTimeoutMs ?? parseWorkflowIntegerString(env.PI_WORKFLOW_AGENT_TIMEOUT_MS),
    WORKFLOW_AGENT_TIMEOUT_MIN_MS,
    WORKFLOW_AGENT_TIMEOUT_MAX_MS,
    DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
  );
  const agentRetries = clampInteger(
    input.agentRetries ?? parseWorkflowIntegerString(env.PI_WORKFLOW_AGENT_RETRIES),
    WORKFLOW_AGENT_RETRIES_MIN,
    WORKFLOW_AGENT_RETRIES_MAX,
    DEFAULT_WORKFLOW_AGENT_RETRIES,
  );
  const budget = input.budget !== undefined ? normalizeExplicitBudget(input.budget) : parseWorkflowBudgetString(env.PI_WORKFLOW_BUDGET);
  const usageLimitMaxAttempts = clampInteger(
    input.usageLimitMaxAttempts ?? parseWorkflowIntegerString(env.PI_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS),
    WORKFLOW_USAGE_LIMIT_ATTEMPTS_MIN,
    WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
    DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_ATTEMPTS,
  );
  const usageLimitMaxDelayMs = clampInteger(
    input.usageLimitMaxDelayMs ?? parseWorkflowIntegerString(env.PI_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS),
    WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
    WORKFLOW_USAGE_LIMIT_DELAY_MAX_MS,
    DEFAULT_WORKFLOW_USAGE_LIMIT_MAX_DELAY_MS,
  );
  return {
    ...input,
    perf: input.perf ?? env.PI_WORKFLOW_PERF === "1",
    concurrency,
    parallelSubmissionLimit: parallelSubmissionLimit ?? null,
    maxAgents,
    agentTimeoutMs,
    agentRetries,
    autoResumeOnUsageLimit: input.autoResumeOnUsageLimit ?? env.PI_WORKFLOW_USAGE_LIMIT_AUTO_RESUME === "1",
    usageLimitMaxAttempts,
    usageLimitMaxDelayMs,
    usageLimitAttempt: clampInteger(
      input.usageLimitAttempt,
      0,
      WORKFLOW_USAGE_LIMIT_ATTEMPTS_MAX,
      0,
    ),
    resumeEditedWorkflow: input.resumeEditedWorkflow === true && hasResumeRunId(input.resumeFromRunId),
    budget: budget ?? null,
  };
}

function hasResumeRunId(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalClampedInteger(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return clampInteger(value, min, max, value);
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export function parseWorkflowIntegerString(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeExplicitBudget(value: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < WORKFLOW_BUDGET_MIN || value > WORKFLOW_BUDGET_MAX) {
    throw new RangeError(`Workflow budget must be an integer between ${WORKFLOW_BUDGET_MIN} and ${WORKFLOW_BUDGET_MAX}.`);
  }
  return value;
}

export function parseWorkflowBudgetString(value: string | undefined): number | undefined {
  const trimmed = value?.trim() ?? "";
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < WORKFLOW_BUDGET_MIN || parsed > WORKFLOW_BUDGET_MAX) return undefined;
  return parsed;
}

function parseRunIdString(value: string | undefined): string | undefined {
  return value === undefined || value === "" || value.startsWith("--") ? undefined : value;
}

/** A `/workflow <name> [flags] [args]` command line with its flags lifted into run options. */
export interface WorkflowInvocation {
  readonly name: string;
  readonly args: string;
  readonly options: WorkflowRunOptions;
  readonly refreshDiscovery: boolean;
  readonly optionErrors: readonly string[];
}

type WorkflowValueOptions = Pick<
  WorkflowRunOptions,
  "concurrency" | "parallelSubmissionLimit" | "maxAgents" | "agentTimeoutMs" | "agentRetries" | "budget" | "resumeFromRunId"
>;

interface WorkflowValueFlag<K extends keyof WorkflowValueOptions> {
  readonly flag: string;
  readonly key: K;
  readonly parse: (value: string | undefined) => WorkflowValueOptions[K] | undefined;
  readonly error: string;
}

type AnyWorkflowValueFlag = { [K in keyof WorkflowValueOptions]-?: WorkflowValueFlag<K> }[keyof WorkflowValueOptions];

/** `--flag=V` or `--flag V`; the next token is consumed only when it parses, so a following flag or argument survives. */
const WORKFLOW_VALUE_FLAGS: readonly AnyWorkflowValueFlag[] = [
  { flag: "--concurrency", key: "concurrency", parse: parseWorkflowIntegerString, error: "--concurrency requires an integer" },
  { flag: "--parallel-limit", key: "parallelSubmissionLimit", parse: parseWorkflowIntegerString, error: "--parallel-limit requires an integer" },
  { flag: "--max-agents", key: "maxAgents", parse: parseWorkflowIntegerString, error: "--max-agents requires an integer" },
  { flag: "--agent-timeout-ms", key: "agentTimeoutMs", parse: parseWorkflowIntegerString, error: "--agent-timeout-ms requires an integer" },
  { flag: "--agent-retries", key: "agentRetries", parse: parseWorkflowIntegerString, error: "--agent-retries requires an integer" },
  { flag: "--budget", key: "budget", parse: parseWorkflowBudgetString, error: "--budget requires a positive integer output-token count" },
  { flag: "--resume", key: "resumeFromRunId", parse: parseRunIdString, error: "--resume requires a workflow run id" },
];

const WORKFLOW_SWITCH_FLAGS = new Map<string, Partial<WorkflowRunOptions>>([
  ["--inspect", { inspect: true }],
  ["--perf", { perf: true }],
  ["--resume-edited", { resumeEditedWorkflow: true }],
  ["--result-viewer", { resultViewer: "open" }],
  ["--review-viewer", { resultViewer: "open" }],
  ["--no-result-viewer", { resultViewer: "skip" }],
  ["--no-review-viewer", { resultViewer: "skip" }],
]);

export function parseWorkflowInvocation(input: string): WorkflowInvocation {
  const [name = "", ...tokens] = input.split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  const options: WorkflowRunOptions = {};
  const optionErrors: string[] = [];
  let refreshDiscovery = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--refresh") {
      refreshDiscovery = true;
      continue;
    }
    const switched = WORKFLOW_SWITCH_FLAGS.get(token);
    if (switched) {
      Object.assign(options, switched);
      continue;
    }
    const valueFlag = WORKFLOW_VALUE_FLAGS.find(({ flag }) => token === flag || token.startsWith(`${flag}=`));
    if (!valueFlag) {
      kept.push(token);
      continue;
    }
    const inline = token !== valueFlag.flag;
    if (applyValueFlag(options, valueFlag, inline ? token.slice(valueFlag.flag.length + 1) : tokens[i + 1])) {
      if (!inline) i++;
    } else {
      optionErrors.push(valueFlag.error);
    }
  }
  if (options.resumeEditedWorkflow && !options.resumeFromRunId) optionErrors.push("--resume-edited requires --resume <run-id>");
  return { name, args: kept.join(" "), options, refreshDiscovery, optionErrors };
}

function applyValueFlag<K extends keyof WorkflowValueOptions>(
  options: WorkflowValueOptions,
  valueFlag: WorkflowValueFlag<K>,
  value: string | undefined,
): boolean {
  const parsed = valueFlag.parse(value);
  if (parsed === undefined) return false;
  options[valueFlag.key] = parsed;
  return true;
}
