import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AdvisoryFinding } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import {
  backfillAdvisoryFindings,
  emptyAdvisoryReport,
  findingLocationKey,
  publishVerifiedKeptProgress,
  sameFinding,
  type AdvisoryVerified,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-advisory-utils.ts";

function finding(file: string, line: number, overrides: Partial<AdvisoryFinding> = {}): AdvisoryFinding {
  return {
    summary: "summary",
    category: "bug",
    severity: "medium",
    confidence: "medium",
    locations: [{ file, line }],
    evidence: [],
    impact: "",
    recommendation: "",
    ...overrides,
  };
}

function verified(file: string, line: number, evidence: string[], impact: string, recommendation: string): AdvisoryVerified {
  return {
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

test("findingLocationKey normalizes diff prefixes", () => {
  assert.equal(findingLocationKey({ locations: [{ file: "a/src/app.ts", line: 10 }] }), "src/app.ts:10");
  assert.equal(sameFinding({ locations: [{ file: "b/src/app.ts", line: 10 }] }, finding("src/app.ts", 10)), true);
});

test("backfillAdvisoryFindings uses indexed first-ranked source", () => {
  const source = verified("src/app.ts", 10, ["first evidence"], "first impact", "first recommendation");
  const duplicate = verified("./src/app.ts", 10, ["second evidence"], "second impact", "second recommendation");
  const [backfilled] = backfillAdvisoryFindings([finding("b/src/app.ts", 10)], [source, duplicate], {
    impact: "default impact",
    recommendation: "default recommendation",
  });

  assert.deepEqual(backfilled?.evidence, ["first evidence"]);
  assert.equal(backfilled?.impact, "first impact");
  assert.equal(backfilled?.recommendation, "first recommendation");
});

test("backfillAdvisoryFindings preserves existing finding fields before defaults", () => {
  const [backfilled] = backfillAdvisoryFindings(
    [finding("src/missing.ts", 1, { evidence: ["existing"], impact: "existing impact", recommendation: "existing recommendation" })],
    [],
    { impact: "default impact", recommendation: "default recommendation" },
  );

  assert.deepEqual(backfilled?.evidence, ["existing"]);
  assert.equal(backfilled?.impact, "existing impact");
  assert.equal(backfilled?.recommendation, "existing recommendation");
});
