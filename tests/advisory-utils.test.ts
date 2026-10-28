import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  backfillAdvisoryFindings,
  emptyAdvisoryReport,
  publishVerifiedKeptProgress,
  type AdvisoryVerified,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";

function verified(file: string, line: number, evidence: string[], impact: string, recommendation: string): AdvisoryVerified {
  return {
    candidateId: "a",
    sourceCandidateIds: ["a"],
    summary: "candidate",
    category: "bug",
    locations: [{ file, line }],
    impact,
    recommendation,
    verdict: "CONFIRMED",
    evidence,
  };
}

test("shared advisory report and verified progress helpers preserve the common contract", () => {
  const stats = { files: 2, candidates: 4, verified: 3, kept: 2 };
  assert.deepEqual(emptyAdvisoryReport("Nothing found.", ["Keep investigating."], stats), {
    summary: "Nothing found.",
    findings: [],
    nextSteps: ["Keep investigating."],
    stats,
  });

  const events: unknown[] = [];
  const logs: string[] = [];
  publishVerifiedKeptProgress({ progress: (event) => events.push(event), log: (message) => logs.push(message) }, 3, 2);
  assert.deepEqual(events, [
    { type: "counter", key: "verified", label: "verified", value: 3 },
    { type: "counter", key: "kept", label: "kept", value: 2 },
    { type: "summary", key: "verified", value: 3 },
    { type: "summary", key: "kept", value: 2 },
  ]);
  assert.deepEqual(logs, ["3 verified → 2 kept"]);
});

test("synthesis merges IDs and reconstructs all evidence from verified sources", () => {
  const source = { ...verified("src/app.ts", 10, ["first evidence"], "first impact", "first recommendation"), candidateId: "a" };
  const other = { ...verified("src/caller.ts", 30, ["second evidence"], "second impact", "second recommendation"), candidateId: "b", sourceCandidateIds: ["b"] };
  const selection = { sourceCandidateIds: ["a", "b"], severity: "high" as const, recommendation: "Fix shared root cause", evidence: ["invented"] };
  const [result] = backfillAdvisoryFindings([selection], [source, other], { impact: "default" });
  assert.deepEqual(result?.sourceCandidateIds, ["a", "b"]);
  assert.deepEqual(result?.evidence, ["first evidence", "second evidence"]);
  assert.deepEqual(result?.locations, [...source.locations, ...other.locations]);
  assert.equal(result?.impact, "first impact\nsecond impact");
});

test("synthesis cannot invent an extra finding or select a refuted source", () => {
  const source = { ...verified("src/app.ts", 10, ["disproof"], "impact", "recommendation"), candidateId: "a", verdict: "REFUTED" as const };
  const selection = (id: string) => ({ sourceCandidateIds: [id], severity: "high" as const, recommendation: "Invented repair" });
  assert.deepEqual(backfillAdvisoryFindings([selection("hallucination"), selection("a")], [source], { impact: "default" }), []);
});

test("synthesis merging a cleanup with a verified bug keeps the higher-ranked classification", () => {
  const bug = { ...verified("src/app.ts", 10, ["Reproduced failure"], "Wrong result", "Repair"), discoveryLenses: ["simplification"] };
  const cleanup = { ...verified("src/caller.ts", 30, ["Maintenance evidence"], "Redundant code", "Simplify"), candidateId: "b", sourceCandidateIds: ["b"], category: "cleanup", discoveryLenses: ["conventions"] };
  const [finding] = backfillAdvisoryFindings([
    { sourceCandidateIds: ["b", "a"], severity: "high", recommendation: "Fix the shared cause" },
  ], [bug, cleanup], { impact: "default" });

  assert.equal(finding?.category, "bug");
  assert.deepEqual(finding?.sourceCandidateIds, ["b", "a"]);
  assert.deepEqual(new Set(finding?.discoveryLenses), new Set(["simplification", "conventions"]));
  assert.deepEqual(finding?.evidence, ["Maintenance evidence", "Reproduced failure"]);
});

test("failed synthesis retains verified evidence and unknown selections become a visible gap", async () => {
  const { resolveAdvisorySynthesis } = await import("../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts");
  const source = { ...verified("src/app.ts", 10, ["proof"], "impact", "repair"), candidateId: "a" };
  const fallback = resolveAdvisorySynthesis(undefined, [source], { impact: "default" }, []);
  assert.deepEqual(fallback.findings[0]?.evidence, ["proof"]);
  const coverage: import("../.pi/extensions/pi-workflow-engine/src/advisory-evidence.ts").AdvisoryStageCoverage[] = [];
  const result = resolveAdvisorySynthesis({ summary: "invented", findings: [{ sourceCandidateIds: ["not-found"], severity: "high", recommendation: "invented" }], nextSteps: [] }, [source], { impact: "default" }, coverage);
  assert.equal(result.findings.length, 0);
  assert.equal(coverage[0]?.failed, 1);
});
