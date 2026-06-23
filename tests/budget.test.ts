import assert from "node:assert/strict";
import { test } from "bun:test";
import { createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { emptyWorkflowUsageTotals, type WorkflowUsageSink, type WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";

/** A usage sink whose output-token total is driven by `getOutput`, so we can model live spend. */
function usageWithOutput(getOutput: () => number): WorkflowUsageSink {
  return {
    recordAgentSession() {},
    snapshot(): WorkflowUsageSnapshot {
      const output = getOutput();
      return {
        agents: [],
        assistantMessages: 0,
        totals: { ...emptyWorkflowUsageTotals(), output, totalTokens: output },
      };
    },
  };
}

test("createBudget with no ceiling reports Infinity remaining", () => {
  const budget = createBudget(null, usageWithOutput(() => 9999));
  assert.equal(budget.total, null);
  assert.equal(budget.spent(), 9999);
  assert.equal(budget.remaining(), Infinity);
});

test("createBudget tracks spend live and clamps remaining at zero", () => {
  let output = 0;
  const budget = createBudget(1000, usageWithOutput(() => output));

  assert.equal(budget.remaining(), 1000);
  output = 400;
  assert.equal(budget.spent(), 400);
  assert.equal(budget.remaining(), 600);
  output = 1500;
  assert.equal(budget.spent(), 1500);
  assert.equal(budget.remaining(), 0);
});
