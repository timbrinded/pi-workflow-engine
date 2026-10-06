import assert from "node:assert/strict";
import { test } from "bun:test";
import type { IdentifiedAdvisoryCandidate } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { WorkflowClassifierUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/classify.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { DUPLICATE_CANDIDATE_CLASSIFIERS, mergeEquivalentCandidates } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";

function candidate(id: string, file: string, summary: string): IdentifiedAdvisoryCandidate {
  return { candidateId: id, sourceCandidateIds: [id], category: "bug", summary, impact: `impact of ${id}`, locations: [{ file, line: 1 }], discoveryEvidence: [`evidence ${id}`] };
}

test("same-file candidates the classifier calls one defect are verified once, keeping every source", async () => {
  const asked: Array<{ pair: string; model: unknown }> = [];
  const classify: WorkflowApi["classify"] = async (context, opts) => {
    const pair = [context.state.first, context.state.second].map((side) => (side as { summary: string }).summary).join(" | ");
    asked.push({ pair, model: opts?.model });
    return { same: { type: "bool", probability: pair === "off by one | extra item per page" ? 0.95 : 0.3 } };
  };
  const logs: string[] = [];

  const merged = await mergeEquivalentCandidates({ classify, parallel: bindParallel({}), log: (line) => logs.push(line) }, [
    candidate("a", "src/orders.ts", "off by one"),
    candidate("b", "src/orders.ts", "missing await"),
    candidate("c", "src/orders.ts", "extra item per page"),
    candidate("d", "src/auth.ts", "off by one"),
  ]);

  assert.deepEqual(merged.map((item) => item.sourceCandidateIds), [["a", "c"], ["b"], ["d"]]);
  assert.deepEqual(merged[0]?.discoveryEvidence, ["evidence a", "evidence c"]);
  // Only the three same-file pairs are compared, each against the measured Jev routes.
  assert.equal(asked.length, 3);
  assert.ok(asked.every((call) => call.model === DUPLICATE_CANDIDATE_CLASSIFIERS));
  assert.deepEqual(logs, ["Merged 1 candidate(s) describing the same defect before verification"]);
});

test("without a Jev classifier the merge makes one probe call and keeps every candidate", async () => {
  let calls = 0;
  const classify: WorkflowApi["classify"] = async () => {
    calls += 1;
    throw new WorkflowClassifierUnavailableError("none");
  };
  const candidates = [candidate("a", "src/x.ts", "one"), candidate("b", "src/x.ts", "two"), candidate("c", "src/x.ts", "three")];

  const merged = await mergeEquivalentCandidates({ classify, parallel: bindParallel({}), log: () => {} }, candidates);

  assert.deepEqual(merged, candidates);
  assert.equal(calls, 1);
});
