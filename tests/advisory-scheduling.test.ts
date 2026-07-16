import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryCandidate, AdvisoryVerdict } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import { bindParallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { runLensVerificationPipeline, type AdvisoryLens } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

interface Verified extends AdvisoryCandidate {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  lens: AdvisoryLens;
}

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

  const result = await runLensVerificationPipeline<AdvisoryLens, Verified>({
    api: {
      agent,
      parallel: bindParallel({ limit: 10 }),
      pipeline,
      progress() {},
      log() {},
    },
    lenses,
    perLens: 2,
    schedulingMode: "finder-barrier",
    finderPrompt: (lens) => `find ${lens.label}`,
    verifierPrompt: (candidate) => `verify ${candidate.summary}`,
    makeVerified: (candidate, lens, verdict) => ({ ...candidate, lens, verdict: verdict.verdict, evidence: verdict.evidence }),
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
