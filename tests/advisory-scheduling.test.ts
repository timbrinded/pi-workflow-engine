import assert from "node:assert/strict";
import { test } from "bun:test";
import { Value } from "typebox/value";
import type { AdvisoryCandidate } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { runLensVerificationPipeline, type AdvisoryLens } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { WorkflowClassifierUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/classify.ts";

/** A host without a classifier: the pipeline skips merging equivalent candidates. */
const noClassifier: WorkflowApi["classify"] = async () => {
  throw new WorkflowClassifierUnavailableError("no classifier in this test");
};

/** An agent limit the pipeline never reaches. */
const roomy: WorkflowApi["agents"] = { max: 64, remaining: () => 64 };

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
      agents: roomy,
      classify: noClassifier,
      parallel: bindParallel({ limit: 10 }),
      phase() {},
      progress() {},
      log() {},
    },
    lenses,
    perLens: 2,
    finderPrompt: (lens) => `find ${lens.label}`,
    verifierPrompt: ([candidate]) => `verify ${candidate!.summary}`,
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

for (const verifierCategories of [undefined, []]) {
  test(`verifier output cannot replace discovery identities or evidence fields with ${verifierCategories ? "empty" : "unset"} categories`, async () => {
    const candidate = candidateFor("original");
    const agent = (async (_prompt: string, opts?: AgentOptions) => {
      if (opts?.label?.startsWith("find:")) return { candidates: [candidate] };
      const verdict = {
        verdict: "CONFIRMED", evidence: ["verified evidence"],
        candidateId: "invented", sourceCandidateIds: ["invented"],
        summary: "invented summary", category: "invented", locations: [],
        reviewAnchor: { file: "invented.ts", line: 1 }, discoveryEvidence: ["invented evidence"],
        discoveryLenses: ["invented"],
      };
      assert.ok(opts?.schema);
      assert.ok(Value.Check(opts.schema, verdict), "an unclassified verifier must accept its ordinary verdict fields");
      return verdict;
    }) as WorkflowApi["agent"];
    const result = await runLensVerificationPipeline({
      api: { agent, agents: roomy, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress() {}, log() {} },
      lenses: lenses.slice(0, 1), perLens: 1,
      verifierCategories,
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
    assert.deepEqual(record.discoveryLenses, ["alpha"]);
    assert.deepEqual(record.evidence, ["verified evidence"]);
  });
}

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
    api: { agent, agents: roomy, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress: (event) => events.push(event), log: (line) => logs.push(line) },
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

test("an agent limit short of one verifier per candidate batches them and keeps a slot for synthesis", async () => {
  const found = [candidateFor("one"), candidateFor("two"), candidateFor("three")];
  const verifierProfiles: unknown[] = [];
  let admitted = 0;
  const agent = (async (prompt: string, opts?: AgentOptions) => {
    admitted++;
    if (opts?.label?.startsWith("find:")) return { candidates: opts.label === "find:alpha" ? found : [] };
    verifierProfiles.push(opts?.profile);
    // The batch verifier judges two of the three records and omits the third.
    const records = JSON.parse(prompt.slice(prompt.indexOf("Candidate records: ") + "Candidate records: ".length)) as { candidateId: string; summary: string }[];
    return { verdicts: records.filter((record) => record.summary !== "candidate three").map((record) => ({ candidateId: record.candidateId, verdict: "CONFIRMED", category: "cleanup", evidence: [`checked ${record.summary}`] })) };
  }) as WorkflowApi["agent"];
  const logs: string[] = [];
  const result = await runLensVerificationPipeline({
    // Four admissions: two finders, then two left — one verifier and one kept for synthesis.
    api: { agent, agents: { max: 4, remaining: () => 4 - admitted }, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress() {}, log: (line) => logs.push(line) },
    lenses, perLens: 3,
    verifierCategories: ["bug", "cleanup"],
    finderPrompt: () => "find", verifierPrompt: (candidates) => `verify ${candidates.length}`,
  });

  assert.deepEqual(verifierProfiles, ["medium"]);
  assert.equal(admitted, 3);
  assert.ok(logs.includes("Verifying 3 candidates in 1 batch(es) to fit the agent limit"));
  assert.deepEqual(result.verified.map((record) => [record.summary, record.verdict, record.category]).sort(), [
    ["candidate one", "CONFIRMED", "cleanup"],
    ["candidate three", "NOT_SUBSTANTIATED", "bug"],
    ["candidate two", "CONFIRMED", "cleanup"],
  ]);
});

test("a failed batch verifier leaves every candidate it held in the coverage", async () => {
  const found = [candidateFor("one"), candidateFor("two"), candidateFor("three")];
  let admitted = 0;
  const agent = (async (_prompt: string, opts?: AgentOptions) => {
    admitted++;
    if (opts?.label?.startsWith("find:")) return { candidates: opts.label === "find:alpha" ? found : [] };
    throw new Error("batch verifier failed schema validation");
  }) as WorkflowApi["agent"];
  const result = await runLensVerificationPipeline({
    api: { agent, agents: { max: 4, remaining: () => 4 - admitted }, classify: noClassifier, parallel: bindParallel({}), phase() {}, progress() {}, log() {} },
    lenses, perLens: 3,
    finderPrompt: () => "find", verifierPrompt: () => "verify",
  });

  const verify = result.coverage.find((stage) => stage.stage === "Verify");
  assert.equal(admitted, 3, "one batch verifier runs for all three candidates");
  assert.deepEqual(result.verified, []);
  assert.deepEqual([verify?.expected, verify?.failed], [3, 3]);
  assert.deepEqual(verify?.failures.map((failure) => failure.candidate?.summary).sort(), ["candidate one", "candidate three", "candidate two"]);
});
