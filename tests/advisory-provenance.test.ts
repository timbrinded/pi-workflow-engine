import assert from "node:assert/strict";
import { test } from "bun:test";
import { bindParallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { identifyCandidates, dedupeCandidates, type AdvisoryStageCoverage } from "../.pi/extensions/pi-workflow-engine/src/advisory-evidence.ts";
import { challengeFindings, parseChallengeArgs } from "../.pi/extensions/pi-workflow-engine/src/advisory-challenge.ts";
import type { AdvisoryCandidate, AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import type { AdvisoryVerified } from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";
import type { WorkflowApi, AgentOptions } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import codeReview from "../.pi/extensions/pi-workflow-engine/workflows/code-review.ts";
import diagnose from "../.pi/extensions/pi-workflow-engine/workflows/diagnose.ts";
import perfReview from "../.pi/extensions/pi-workflow-engine/workflows/perf-review.ts";
import refactorScout from "../.pi/extensions/pi-workflow-engine/workflows/refactor-scout.ts";

const candidate: AdvisoryCandidate = { summary: "Wrong condition", category: "bug", locations: [{ file: "src/app.ts", line: 2 }], impact: "Drops requests" };
function apiFor(handler: (prompt: string, options: AgentOptions) => unknown): WorkflowApi {
  return { agent: (async (prompt: string, options: AgentOptions = {}) => handler(prompt, options)) as WorkflowApi["agent"],
    parallel: bindParallel({}), pipeline, phase() {}, log() {}, progress() {}, args: "", cwd: process.cwd(), signal: undefined,
    budget: { total: null, spent: () => 0, remaining: () => Infinity }, workflow: async () => undefined };
}
const material = async () => ({ ok: true as const, diff: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,2 @@\n old\n+new\n", snapshot: { status: "unavailable" as const, reason: "test" } });
const workflows = [
  { name: "code-review", run: (api: WorkflowApi) => codeReview(api, { captureReviewMaterial: material }) },
  { name: "diagnose", run: diagnose }, { name: "perf-review", run: perfReview }, { name: "refactor-scout", run: refactorScout },
];
for (const workflow of workflows) {
  for (const failure of ["finder", "verifier"] as const) {
    test(`${workflow.name} preserves ${failure} failure and cannot report a clean result`, async () => {
      let finders = 0;
      const api = apiFor((_prompt, options) => {
        if (options.label === "scope") return { diffCommand: "git diff", symptom: "lost requests", target: "src", files: ["src/app.ts"], commands: [], observations: [], summary: "scope" };
        if (options.label?.startsWith("find:") || options.label?.startsWith("hypothesize:")) {
          if (++finders === 1) {
            if (failure === "finder") throw new Error("finder unavailable");
            return { candidates: [candidate] };
          }
          return { candidates: [] };
        }
        if (options.label?.startsWith("verify:")) throw new Error("verifier unavailable");
        throw new Error("unexpected call");
      });
      const result = await workflow.run(api) as AdvisoryReport & { status: string; coverage: AdvisoryStageCoverage[]; gaps: string[] };
      assert.equal(result.status, "incomplete");
      assert.match(result.summary, /Incomplete/);
      assert.doesNotMatch(result.summary, /No findings survived/);
      assert.equal(result.coverage.find((stage) => stage.stage === (failure === "finder" ? "Find" : "Verify"))?.failed, 1);
      assert.ok(result.gaps.some((gap) => gap.includes(`${failure} unavailable`)));
    });
  }
}

test("distinct defects on the same range reach verification and cross-file evidence keeps a changed-line anchor", async () => {
  const candidates = [candidate, { ...candidate, summary: "Independent leak", locations: [{ file: "src/caller.ts", line: 90 }, ...candidate.locations], reviewAnchor: candidate.locations[0] }];
  let finders = 0;
  let verifiers = 0;
  const api = apiFor((prompt, options) => {
    if (options.label === "scope") return { diffCommand: "git diff", files: ["src/app.ts"], summary: "scope" };
    if (options.label?.startsWith("find:")) return { candidates: ++finders === 1 ? candidates : [] };
    if (options.label?.startsWith("verify:")) { verifiers++; return { verdict: "CONFIRMED", evidence: ["src/caller.ts:90 reaches the changed condition"] }; }
    const ids = [...prompt.matchAll(/IDs: ([a-f0-9, ]+)/g)].map((match) => match[1]!.trim().split(", "));
    return { summary: "Two defects", findings: ids.map((sourceCandidateIds) => ({ sourceCandidateIds, severity: "medium", recommendation: "Repair" })), nextSteps: [] };
  });
  const result = await codeReview(api, { captureReviewMaterial: material }) as AdvisoryReport;
  assert.equal(verifiers, 2);
  assert.equal(result.findings.length, 2);
  assert.ok(result.findings.some((finding) => finding.locations.some((location) => location.file === "src/caller.ts")));
  assert.ok(result.findings.every((finding) => finding.reviewAnchor?.file === "src/app.ts"));
});

test("near-exact duplicates from different lenses preserve all identities and discovery evidence", () => {
  const first = identifyCandidates([{ ...candidate, discoveryEvidence: ["first evidence"] }], "first")[0]!;
  const second = identifyCandidates([{ ...candidate, summary: "  WRONG   condition. ", discoveryEvidence: ["second evidence"] }], "second")[0]!;
  const merged = dedupeCandidates([first, second]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]?.sourceCandidateIds, [first.candidateId!, second.candidateId!]);
  assert.deepEqual(merged[0]?.discoveryEvidence, ["first evidence", "second evidence"]);
  assert.deepEqual(identifyCandidates([candidate], "same"), identifyCandidates([candidate], "same"));
});

for (const outcome of ["refuted", "unresolved", "upheld"] as const) {
  test(`selective challenge preserves ${outcome} and both sides of evidence`, async () => {
    const coverage: AdvisoryStageCoverage[] = [];
    const findings: AdvisoryVerified[] = [
      { ...identifyCandidates([candidate], "low")[0]!, verdict: "CONFIRMED", evidence: ["low-risk proof"] },
      { ...identifyCandidates([candidate], "uncertain")[0]!, verdict: "PLAUSIBLE", evidence: ["verifier evidence"] },
    ];
    const calls: string[] = [];
    const api = apiFor((prompt, options) => {
      calls.push(options.label!);
      if (options.label?.startsWith("challenge:")) {
        assert.match(prompt, /DISPROVE/);
        return { outcome: outcome === "upheld" ? "no-counterexample" : "counterexample", evidence: ["challenger evidence"], experiment: "observed experiment" };
      }
      assert.match(prompt, /verifier evidence/);
      assert.match(prompt, /challenger evidence/);
      return { outcome, evidence: ["adjudicator evidence"], reason: "reason" };
    });
    const result = await challengeFindings(api, findings, "snapshot context", { maxChallenges: 1 }, coverage);
    assert.equal(calls.length, 2);
    assert.deepEqual(result[0], findings[0]);
    assert.equal(result[1]?.verdict, outcome === "refuted" ? "REFUTED" : outcome === "unresolved" ? "NOT_SUBSTANTIATED" : "PLAUSIBLE");
    assert.ok(result[1]?.evidence.includes("verifier evidence"));
    assert.ok(result[1]?.evidence.includes("challenger evidence"));
    assert.equal(result[1]?.challenge?.status, "complete");
  });
}

test("challenge is opt-in, bounded, and failures preserve the candidate as unresolved", async () => {
  assert.equal(parseChallengeArgs("src").options.maxChallenges, 0);
  assert.equal(parseChallengeArgs("src --challenge=99").options.maxChallenges, 10);
  assert.equal(parseChallengeArgs("--challenge src").args, "src");
  const coverage: AdvisoryStageCoverage[] = [];
  const finding: AdvisoryVerified = { ...identifyCandidates([candidate], "lens")[0]!, verdict: "PLAUSIBLE", evidence: ["original"] };
  const result = await challengeFindings(apiFor(() => { throw new Error("provider unavailable"); }), [finding], "snapshot", { maxChallenges: 1 }, coverage);
  assert.equal(result[0]?.verdict, "NOT_SUBSTANTIATED");
  assert.equal(result[0]?.challenge?.status, "failed");
  assert.equal(coverage[0]?.failed, 1);
});

for (const value of ["", "-1", "abc", "1.5", "Infinity"]) {
  test(`invalid challenge value ${JSON.stringify(value)} fails before discovery`, async () => {
    const args = `src --challenge=${value}`;
    assert.throws(() => parseChallengeArgs(args), /Invalid --challenge value/);
    let calls = 0;
    const api = apiFor(() => { calls++; throw new Error("Agent must not start"); });
    api.args = args;
    await assert.rejects(codeReview(api), /Invalid --challenge value/);
    assert.equal(calls, 0);
  });
}

test("challenge parser preserves valid defaults, zero and bounded integer limits", () => {
  assert.deepEqual(parseChallengeArgs("src --challenge"), { args: "src", options: { maxChallenges: 3 } });
  assert.deepEqual(parseChallengeArgs("src --challenge=0"), { args: "src", options: { maxChallenges: 0 } });
  assert.deepEqual(parseChallengeArgs("--challenge=2 src"), { args: "src", options: { maxChallenges: 2 } });
  assert.deepEqual(parseChallengeArgs("src --challenge=99"), { args: "src", options: { maxChallenges: 10 } });
});
