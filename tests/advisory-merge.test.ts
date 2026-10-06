import assert from "node:assert/strict";
import { test } from "bun:test";
import type { IdentifiedAdvisoryCandidate } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { WorkflowAbortError } from "../.pi/extensions/pi-workflow-engine/src/cancellation.ts";
import { WorkflowClassifierError, WorkflowClassifierUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/classify.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { DUPLICATE_CANDIDATE_CLASSIFIERS, mergeEquivalentCandidates } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";

function candidate(id: string, file: string, summary: string, anchor?: string): IdentifiedAdvisoryCandidate {
  return {
    candidateId: id, sourceCandidateIds: [id], category: "bug", summary, impact: `impact of ${id}`,
    locations: [{ file, line: 1 }], discoveryEvidence: [`evidence ${id}`],
    ...(anchor ? { reviewAnchor: { file: anchor, line: 2 } } : {}),
  };
}

/** A classifier that answers "same defect" with the probability listed for that pair of summaries. */
function classifierFor(same: Record<string, number>, calls: Array<{ pair: string; model: unknown }> = []): WorkflowApi["classify"] {
  return async (context, opts) => {
    const pair = [context.state.first, context.state.second].map((side) => (side as { summary: string }).summary).join(" | ");
    calls.push({ pair, model: opts?.model });
    return { same: { type: "bool", probability: same[pair] ?? 0.1 } };
  };
}

const run = (classify: WorkflowApi["classify"], candidates: IdentifiedAdvisoryCandidate[], logs: string[] = []) =>
  mergeEquivalentCandidates({ classify, parallel: bindParallel({}), log: (line) => logs.push(line) }, candidates);

test("same-file candidates the classifier calls one defect are verified once, keeping every source and wording", async () => {
  const calls: Array<{ pair: string; model: unknown }> = [];
  const logs: string[] = [];

  const merged = await run(classifierFor({ "off by one | extra item per page": 0.95 }, calls), [
    candidate("a", "src/orders.ts", "off by one"),
    candidate("b", "src/orders.ts", "missing await"),
    candidate("c", "src/orders.ts", "extra item per page"),
    candidate("d", "src/auth.ts", "off by one"),
  ], logs);

  assert.deepEqual(merged.map((item) => item.sourceCandidateIds), [["a", "c"], ["b"], ["d"]]);
  assert.deepEqual(merged[0]?.discoveryEvidence, ["evidence a", "evidence c", "Also reported as: extra item per page"]);
  // Only the three same-file pairs are compared, each against the measured Jev routes.
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.model === DUPLICATE_CANDIDATE_CLASSIFIERS));
  assert.deepEqual(logs, [
    "Comparing 3 same-file candidate pairs for duplicates",
    "Merged 1 candidate(s) describing the same defect before verification",
  ]);
});

test("a vague candidate that resembles two different defects cannot chain them into one", async () => {
  const merged = await run(classifierFor({
    "missing await | error handling is wrong": 0.9,
    "error handling is wrong | off by one": 0.9,
    "missing await | off by one": 0.1,
  }), [
    candidate("a", "src/orders.ts", "missing await"),
    candidate("b", "src/orders.ts", "error handling is wrong"),
    candidate("c", "src/orders.ts", "off by one"),
  ]);

  assert.deepEqual(merged.map((item) => item.sourceCandidateIds), [["a", "b"], ["c"]]);
});

test("pairs use the changed-line anchor and the repository-relative path", async () => {
  const calls: Array<{ pair: string; model: unknown }> = [];
  await run(classifierFor({}, calls), [
    candidate("a", "./src/orders.ts", "one"),
    candidate("b", "a/src/orders.ts", "two"),
    candidate("c", "src/caller.ts", "three", "src/orders.ts"),
    candidate("d", "src/orders.ts", "four", "src/other.ts"),
  ]);

  assert.deepEqual(calls.map((call) => call.pair).sort(), ["one | three", "one | two", "two | three"]);
});

test("a failed probe skips the merge after one call, quietly when no Jev route is configured", async () => {
  for (const [error, logged] of [
    [new WorkflowClassifierUnavailableError("none"), []],
    [new WorkflowClassifierError("dedup: classifier error: 401 unauthorized"), ["Skipped merging duplicate candidates: dedup: classifier error: 401 unauthorized"]],
  ] as const) {
    let calls = 0;
    const logs: string[] = [];
    const candidates = [candidate("a", "src/x.ts", "one"), candidate("b", "src/x.ts", "two"), candidate("c", "src/x.ts", "three")];

    const merged = await run(async () => {
      calls += 1;
      throw error;
    }, candidates, logs);

    assert.deepEqual(merged, candidates);
    assert.equal(calls, 1);
    assert.deepEqual(logs, logged);
  }
});

test("an aborted run is not mistaken for a missing classifier", async () => {
  await assert.rejects(
    () => run(async () => {
      throw new WorkflowAbortError("stopped");
    }, [candidate("a", "src/x.ts", "one"), candidate("b", "src/x.ts", "two")]),
    WorkflowAbortError,
  );
});
