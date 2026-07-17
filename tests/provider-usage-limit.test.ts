import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  providerErrorFromMessages,
  WorkflowProviderError,
} from "../.pi/extensions/pi-workflow-engine/src/agent-retry.ts";
import {
  createProviderUsageLimitPauseRecord,
  parseProviderResetHint,
  providerUsageLimitFromMessages,
  WorkflowProviderUsageLimitError,
} from "../.pi/extensions/pi-workflow-engine/src/provider-usage-limit.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";

const NOW = Date.parse("2026-07-17T12:00:00Z");

function failed(errorMessage: string): unknown {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage,
    provider: "openai",
    model: "gpt-test",
    api: "openai-responses",
  };
}

test("provider usage limits require terminal failure metadata and an explicit background policy", () => {
  assert.equal(providerUsageLimitFromMessages([{ role: "assistant", stopReason: "stop", errorMessage: "rate limit" }]), undefined);
  assert.equal(providerUsageLimitFromMessages([
    failed("rate_limit_error: retry-after: 60"),
    { role: "assistant", stopReason: "stop" },
  ]), undefined);

  const foreground = providerErrorFromMessages([failed("429 insufficient_quota")]);
  assert.ok(foreground instanceof WorkflowProviderError);
  assert.equal(foreground.retryable, false);

  const background = providerErrorFromMessages(
    [failed("rate_limit_error: x-ratelimit-reset-tokens: 6m0s")],
    { pauseOnUsageLimit: true },
  );
  assert.ok(background instanceof WorkflowProviderUsageLimitError);
  assert.equal(background.details.provider, "openai");
  assert.equal(background.details.providerMessage, "rate_limit_error: x-ratelimit-reset-tokens: 6m0s");
});

test("provider reset hints parse OpenAI durations, Anthropic seconds, and RFC3339 timestamps", () => {
  assert.deepEqual(
    parseProviderResetHint("x-ratelimit-reset-tokens: 6m0s", NOW),
    { resetHint: "x-ratelimit-reset-tokens: 6m0s", resetAt: NOW + 360_000 },
  );
  assert.deepEqual(
    parseProviderResetHint("retry-after: 60", NOW),
    { resetHint: "retry-after: 60", resetAt: NOW + 60_000 },
  );
  assert.deepEqual(
    parseProviderResetHint("limit resets at 2026-07-17T13:15:30Z", NOW),
    { resetHint: "2026-07-17T13:15:30Z", resetAt: Date.parse("2026-07-17T13:15:30Z") },
  );
});

test("malformed reset hints retain diagnostic text without inventing a deadline", () => {
  assert.deepEqual(
    parseProviderResetHint("retry-after: sometime-later", NOW),
    { resetHint: "retry-after: sometime-later" },
  );
  assert.deepEqual(
    parseProviderResetHint("reset at 2025-01-01T00:00:00Z", NOW),
    { resetHint: "2025-01-01T00:00:00Z" },
  );
});

test("pause scheduling clamps reset delays and stops at the total-attempt bound", () => {
  const error = new WorkflowProviderUsageLimitError({
    stopReason: "error",
    providerMessage: "rate limit",
    resetAt: NOW + 120_000,
  });
  const first = createProviderUsageLimitPauseRecord(error, resolveWorkflowRunOptions({
    autoResumeOnUsageLimit: true,
    usageLimitMaxAttempts: 3,
    usageLimitMaxDelayMs: 30_000,
  }, {}), true, NOW);
  assert.equal(first.pause.attempt, 1);
  assert.equal(first.pause.nextEligibleAt, NOW + 30_000);
  assert.equal(first.pause.autoResume, true);

  const exhausted = createProviderUsageLimitPauseRecord(error, resolveWorkflowRunOptions({
    autoResumeOnUsageLimit: true,
    usageLimitMaxAttempts: 3,
    usageLimitAttempt: 2,
  }, {}), true, NOW);
  assert.equal(exhausted.pause.attempt, 3);
  assert.equal(exhausted.pause.autoResume, false);

  const unsafeReplay = createProviderUsageLimitPauseRecord(error, resolveWorkflowRunOptions({
    autoResumeOnUsageLimit: true,
  }, {}), false, NOW);
  assert.equal(unsafeReplay.pause.autoResume, false);
});

test("ordinary transport, billing, context, and unrelated numeric failures are not usage limits", () => {
  const falsePositives = [
    "503 service unavailable",
    "network connection reset",
    "billing account is disabled",
    "context length limit exceeded",
    "invalid configuration: rate limit must be positive",
    "invalid model",
    "failed while processing 429 records",
  ];
  for (const message of falsePositives) {
    assert.equal(providerUsageLimitFromMessages([failed(message)], NOW), undefined, message);
  }

  for (const message of [
    "HTTP 429 Too Many Requests",
    "ResourceExhausted: quota exceeded",
    "FreeUsageLimitError: weekly limit reached",
    "monthly usage limit reached",
    "You exceeded your current quota",
  ]) {
    assert.ok(providerUsageLimitFromMessages([failed(message)], NOW) instanceof WorkflowProviderUsageLimitError, message);
  }
});
