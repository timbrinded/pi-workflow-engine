import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryCandidate } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { runLensVerificationPipeline, type AdvisoryLens } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

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
    return { verdict: "CONFIRMED", evidence: [`evidence for ${label}`], confidence: "high" };
  }) as WorkflowApi["agent"];

  const result = await runLensVerificationPipeline({
    api: {
      agent,
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
    api: { agent, parallel: bindParallel({}), phase() {}, progress() {}, log() {} },
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
