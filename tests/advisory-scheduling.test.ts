import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryCandidate } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { runLensVerificationPipeline, type AdvisoryLens } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { WorkflowClassifierUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/classify.ts";

/** A host without a classifier: the pipeline skips merging equivalent candidates. */
const noClassifier: WorkflowApi["classify"] = async () => {
  throw new WorkflowClassifierUnavailableError("no classifier in this test");
};

const lenses: AdvisoryLens[] = [
  { label: "alpha", category: "bug", text: "alpha lens" },
  { label: "beta", category: "bug", text: "beta lens" },
];

test("finder-barrier scheduling starts all finders before verifiers", async () => {
  const calls: string[] = [];
  const agent = (async (_prompt: string, opts?: AgentOptions) => {
    const label = opts?.label ?? "agent";
    calls.push(label);
    if (label.startsWith("find:")) {
      await Promise.resolve();
      return { candidates: [candidateFor(label)] };
    }
    return { verdict: "CONFIRMED", evidence: [`evidence for ${label}`] };
  }) as WorkflowApi["agent"];

  const result = await runLensVerificationPipeline({
    api: {
      agent,
      classify: noClassifier,
      parallel: bindParallel({ limit: 10 }),
      phase() {},
      progress() {},
      log() {},
    },
    lenses,
    perLens: 2,
    finderPrompt: (lens) => `find ${lens.label}`,
    verifierPrompt: (candidate) => `verify ${candidate.summary}`,
  });

  assert.equal(result.verified.length, 2);
  const firstVerify = calls.findIndex((label) => label.startsWith("verify:"));
  const lastFind = Math.max(...calls.map((label, index) => (label.startsWith("find:") ? index : -1)));
  assert.ok(firstVerify > lastFind, `expected verifier after finders, got ${calls.join(", ")}`);
});

function candidateFor(label: string): AdvisoryCandidate {
  return {
    summary: `candidate ${label}`,
    category: "bug",
    locations: [{ file: `src/${label}.ts`, line: label.endsWith("alpha") ? 10 : 20 }],
    impact: `impact ${label}`,
  };
}

test("verifier output cannot replace discovery identities or evidence fields", async () => {
  const candidate = candidateFor("original");
  const agent = (async (_prompt: string, opts?: AgentOptions) => {
    if (opts?.label?.startsWith("find:")) return { candidates: [candidate] };
    return {
      verdict: "CONFIRMED", evidence: ["verified evidence"],
      candidateId: "invented", sourceCandidateIds: ["invented"],
      summary: "invented summary", category: "invented", locations: [],
      reviewAnchor: { file: "invented.ts", line: 1 }, discoveryEvidence: ["invented evidence"],
    };
  }) as WorkflowApi["agent"];
  const result = await runLensVerificationPipeline({
    api: { agent, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress() {}, log() {} },
    lenses: lenses.slice(0, 1), perLens: 1,
    finderPrompt: () => "find", verifierPrompt: () => "verify",
  });
  assert.equal(result.verified.length, 1);
  const record = result.verified[0]!;
  assert.notEqual(record.candidateId, "invented");
  assert.deepEqual(record.sourceCandidateIds, [record.candidateId]);
  assert.equal(record.summary, candidate.summary);
  assert.equal(record.category, candidate.category);
  assert.deepEqual(record.locations, candidate.locations);
  assert.equal(record.reviewAnchor, undefined);
  assert.equal(record.discoveryEvidence, undefined);
  assert.deepEqual(record.evidence, ["verified evidence"]);
});

test("candidates over the per-lens cap are logged per lens and counted as dropped", async () => {
  const shared = candidateFor("shared");
  const found: Record<string, AdvisoryCandidate[]> = {
    "find:alpha": [shared, candidateFor("alpha-2"), candidateFor("alpha-3")],
    "find:beta": [shared, candidateFor("beta-2")],
  };
  const agent = (async (_prompt: string, opts?: AgentOptions) => {
    const label = opts?.label ?? "";
    if (label.startsWith("find:")) return { candidates: found[label] ?? [] };
    return { verdict: "CONFIRMED", evidence: ["verified evidence"] };
  }) as WorkflowApi["agent"];
  const events: WorkflowProgressEvent[] = [];
  const logs: string[] = [];
  const result = await runLensVerificationPipeline({
    api: { agent, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress: (event) => events.push(event), log: (line) => logs.push(line) },
    lenses, perLens: 2,
    finderPrompt: () => "find", verifierPrompt: () => "verify",
  });

  // alpha's third candidate is over the cap; beta's copy of the shared candidate is a duplicate.
  assert.deepEqual(logs.filter((line) => line.startsWith("Dropped")), [
    "Dropped 1 alpha candidate(s) over the per-lens cap of 2",
    "Dropped 1 duplicate or out-of-scope candidate(s)",
  ]);
  const total = (key: string) => events.reduce((sum, event) => sum + (event.type === "counter_delta" && event.key === key ? event.delta : 0), 0);
  assert.equal(total("candidates"), 5);
  assert.equal(total("dropped"), 2);
  assert.equal(result.rawCandidates, 5);
  assert.equal(result.dropped, 2);
  assert.deepEqual(result.verified.map((record) => record.summary).sort(), ["candidate alpha-2", "candidate beta-2", "candidate shared"]);
});
