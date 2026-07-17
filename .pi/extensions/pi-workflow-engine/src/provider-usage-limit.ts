import { WorkflowPauseError } from "./cancellation.ts";
import {
  WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
  type ResolvedWorkflowRunOptions,
} from "./options.ts";
import type { WorkflowProviderUsageLimitPause } from "./workflow-run-record.ts";

export const WORKFLOW_PROVIDER_USAGE_LIMIT_CODE = "WORKFLOW_PROVIDER_USAGE_LIMIT";
export const WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS = 60_000;
const MAX_RESET_HINT_LENGTH = 512;

export interface ProviderUsageLimitDetails {
  readonly stopReason: "error";
  readonly providerMessage: string;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
  readonly resetHint?: string;
  readonly resetAt?: number;
}

export interface ProviderUsageLimitPauseRecord {
  readonly message: string;
  readonly pause: WorkflowProviderUsageLimitPause;
}

/** Fatal-to-the-current-run provider limit that remains resumable from its journal boundary. */
export class WorkflowProviderUsageLimitError extends WorkflowPauseError {
  override readonly name = "WorkflowProviderUsageLimitError";
  readonly code = WORKFLOW_PROVIDER_USAGE_LIMIT_CODE;

  constructor(readonly details: ProviderUsageLimitDetails) {
    super(details.providerMessage);
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly code: string;
    readonly details: ProviderUsageLimitDetails;
  } {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}

export function providerUsageLimitFromMessages(
  messages: readonly unknown[],
  now = Date.now(),
): WorkflowProviderUsageLimitError | undefined {
  const message = messages.findLast(isAssistantMessage);
  if (!message || message.stopReason !== "error") return undefined;
  const providerMessage = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!providerMessage || !isUsageLimitMessage(providerMessage)) return undefined;
  const reset = parseProviderResetHint(providerMessage, now);
  const provider = stringDetail(message.provider);
  const model = stringDetail(message.model);
  const api = stringDetail(message.api);
  return new WorkflowProviderUsageLimitError({
    stopReason: "error",
    providerMessage,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(api ? { api } : {}),
    ...reset,
  });
}

export function createProviderUsageLimitPauseRecord(
  error: WorkflowProviderUsageLimitError,
  options: ResolvedWorkflowRunOptions,
  replayableInvocation: boolean,
  now = Date.now(),
): ProviderUsageLimitPauseRecord {
  const attempt = options.usageLimitAttempt + 1;
  const hintedDelay = error.details.resetAt === undefined
    ? WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS
    : error.details.resetAt - now;
  const delayMs = Math.min(
    options.usageLimitMaxDelayMs,
    Math.max(
      WORKFLOW_USAGE_LIMIT_DELAY_MIN_MS,
      hintedDelay > 0 ? hintedDelay : WORKFLOW_USAGE_LIMIT_FALLBACK_DELAY_MS,
    ),
  );
  const autoResume = options.autoResumeOnUsageLimit
    && attempt < options.usageLimitMaxAttempts
    && replayableInvocation;
  return {
    message: autoResume
      ? `Provider usage limit paused this run; automatic attempt ${attempt + 1}/${options.usageLimitMaxAttempts} is scheduled.`
      : `Provider usage limit paused this run at attempt ${attempt}/${options.usageLimitMaxAttempts}.`,
    pause: {
      kind: "provider_usage_limit",
      reason: "provider_usage_limit",
      providerMessage: error.details.providerMessage,
      provider: error.details.provider,
      model: error.details.model,
      api: error.details.api,
      resetHint: error.details.resetHint,
      attempt,
      nextEligibleAt: now + delayMs,
      autoResume,
      maxAttempts: options.usageLimitMaxAttempts,
    },
  };
}

export function parseProviderResetHint(
  message: string,
  now = Date.now(),
): { readonly resetHint?: string; readonly resetAt?: number } {
  const iso = message.match(
    /(?:[a-z-]*reset[a-z-]*|resets?\s+at|available\s+again\s+at)\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i,
  )?.[1];
  if (iso) {
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) && parsed > now
      ? { resetHint: boundedHint(iso), resetAt: parsed }
      : { resetHint: boundedHint(iso) };
  }

  const labelled = message.match(
    /(?:retry[- ]after|try again in|resets? in|available again in|x-ratelimit-reset(?:-[a-z-]+)?)\s*[:=]?\s*((?:\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\s*)+)/i,
  );
  if (labelled?.[1]) {
    const delayMs = parseDurationMs(labelled[1]);
    return delayMs === undefined
      ? { resetHint: boundedHint(labelled[0]) }
      : { resetHint: boundedHint(labelled[0]), resetAt: now + delayMs };
  }

  const retryAfter = message.match(/retry[- ]after\s*[:=]\s*([^\s,;]+)/i);
  if (retryAfter?.[1]) {
    const seconds = Number(retryAfter[1]);
    return Number.isFinite(seconds) && seconds >= 0
      ? { resetHint: boundedHint(retryAfter[0]), resetAt: now + seconds * 1_000 }
      : { resetHint: boundedHint(retryAfter[0]) };
  }
  return {};
}

function isUsageLimitMessage(message: string): boolean {
  return /(?:GoUsageLimitError|FreeUsageLimitError|insufficient_quota|rate_limit_error|ResourceExhausted)/i.test(message)
    || /\btoo many requests\b/i.test(message)
    || /\b(?:http|status(?: code)?|error)\s*[:=]?\s*429\b/i.test(message)
    || /\b429\b[^\n]*(?:rate|requests?|quota|limit)/i.test(message)
    || /\b(?:usage|quota|monthly|weekly|daily)\s+(?:window\s+)?limit\b/i.test(message)
    || /\bquota\s+(?:has\s+been\s+)?exceeded\b/i.test(message)
    || /\bexceeded\b[^\n]*\bquota\b/i.test(message)
    || /\b(?:usage|rate)\s+limit\s+(?:(?:has\s+been|was)\s+)?(?:reached|exceeded)\b/i.test(message);
}

function parseDurationMs(value: string): number | undefined {
  const unitPattern = /(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gi;
  let total = 0;
  let matched = "";
  for (const part of value.matchAll(unitPattern)) {
    const amount = Number(part[1]);
    const unit = part[2]?.toLowerCase();
    if (!Number.isFinite(amount) || !unit) return undefined;
    matched += part[0];
    if (unit === "ms" || unit.startsWith("millisecond")) total += amount;
    else if (unit === "s" || unit.startsWith("sec")) total += amount * 1_000;
    else if (unit === "m" || unit.startsWith("min")) total += amount * 60_000;
    else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) total += amount * 3_600_000;
    else total += amount * 86_400_000;
  }
  if (!matched || value.replace(/\s+/g, "") !== matched.replace(/\s+/g, "")) return undefined;
  return Number.isFinite(total) && total >= 0 ? total : undefined;
}

function boundedHint(value: string): string {
  return value.length <= MAX_RESET_HINT_LENGTH ? value : `${value.slice(0, MAX_RESET_HINT_LENGTH - 1)}…`;
}

function isAssistantMessage(value: unknown): value is {
  readonly role: "assistant";
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly api?: unknown;
} {
  return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
