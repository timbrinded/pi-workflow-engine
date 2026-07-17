import assert from "node:assert/strict";
import { test } from "bun:test";
import { ReviewFixBudgetLedger } from "../.pi/extensions/pi-workflow-engine/src/review/review-budget.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

function usage(output: number): WorkflowUsageSnapshot {
  return {
    agents: [],
    assistantMessages: 0,
    totals: {
      input: 0,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

test("review fix budget ledger records primary and failed-preview usage", () => {
  const ledger = new ReviewFixBudgetLedger(100, usage(60));
  assert.equal(ledger.remaining, 40);

  const lease = ledger.acquire();
  assert.equal(lease.ok, true);
  assert.deepEqual(ledger.acquire(), { ok: false, reason: "busy" });

  // Usage is finalized even when the surrounding preview later rejects.
  ledger.record(usage(25));
  assert.equal(ledger.remaining, 15);
  if (lease.ok) lease.release();

  const retry = ledger.acquire();
  assert.equal(retry.ok, true);
  ledger.record(usage(20));
  if (retry.ok) retry.release();
  assert.equal(ledger.remaining, 0);
  assert.deepEqual(ledger.acquire(), { ok: false, reason: "exhausted" });
});

test("review fix budget ledger leaves uncapped reviews uncapped", () => {
  const ledger = new ReviewFixBudgetLedger(undefined, usage(50));
  ledger.record(usage(500));
  assert.equal(ledger.remaining, undefined);
});
