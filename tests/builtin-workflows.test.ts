import assert from "node:assert/strict";
import { test } from "bun:test";
import codeReview from "../.pi/extensions/pi-workflow-engine/workflows/code-review.ts";
import diagnose from "../.pi/extensions/pi-workflow-engine/workflows/diagnose.ts";
import perfReview from "../.pi/extensions/pi-workflow-engine/workflows/perf-review.ts";
import refactorScout from "../.pi/extensions/pi-workflow-engine/workflows/refactor-scout.ts";
import { parallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import type { AdvisoryCandidate, AdvisoryFinding, AdvisoryReport } from "../.pi/extensions/pi-workflow-engine/src/advisory-schema.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent, WorkflowRunStats } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

interface AgentCall {
  prompt: string;
  label: string | undefined;
  phase: string | undefined;
  tools: string[] | undefined;
  toolHints: readonly string[] | undefined;
}

interface ScriptedApi extends WorkflowApi {
  readonly calls: AgentCall[];
  readonly phases: string[];
  readonly logs: string[];
  readonly events: WorkflowProgressEvent[];
}

type ReportResult = AdvisoryReport & {
  stats: WorkflowRunStats;
};

function createScriptedApi(responses: unknown[], args = ""): ScriptedApi {
  const queue = [...responses];
  const calls: AgentCall[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  const events: WorkflowProgressEvent[] = [];
  const agent = (async (prompt: string, opts?: AgentOptions) => {
    calls.push({ prompt, label: opts?.label, phase: opts?.phase, tools: opts?.tools, toolHints: opts?.toolHints });
    if (queue.length === 0) throw new Error(`No scripted response for agent ${opts?.label ?? "(unlabelled)"}`);
    return queue.shift();
  }) as WorkflowApi["agent"];

  return {
    calls,
    phases,
    logs,
    events,
    agent,
    workflow: async () => {
      throw new Error("sub-workflows are not enabled in these tests");
    },
    parallel,
    pipeline,
    phase: (title) => phases.push(title),
    log: (message) => logs.push(message),
    progress: (event) => events.push(event),
    args,
    cwd: process.cwd(),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    signal: undefined,
  };
}

function candidate(summary: string, category: string, file = "src/example.ts", line = 12): AdvisoryCandidate {
  return {
    summary,
    category,
    locations: [{ file, line }],
    impact: `${summary} impact`,
    recommendation: `${summary} recommendation`,
  };
}

function finding(summary: string, category: string, confidence: AdvisoryFinding["confidence"] = "high"): AdvisoryFinding {
  return {
    summary,
    category,
    severity: "medium",
    confidence,
    locations: [{ file: "src/example.ts", line: 12 }],
    evidence: [`${summary} evidence`],
    impact: `${summary} impact`,
    recommendation: `${summary} recommendation`,
  };
}

function report(summary: string, findings: AdvisoryFinding[] = []): AdvisoryReport {
  return {
    summary,
    findings,
    nextSteps: findings.length > 0 ? ["Review the finding."] : ["No action."],
  };
}

function asReportResult(value: unknown): ReportResult {
  assert.ok(value && typeof value === "object", "expected object result");
  return value as ReportResult;
}

function emptyCandidates(): { candidates: AdvisoryCandidate[] } {
  return { candidates: [] };
}

const EXPECTED_ADVISORY_TOOLS = ["read", "bash", "grep", "find", "ls"];
const EXPECTED_ADVISORY_TOOL_HINTS = ["search"];

test("built-in advisory workflows request dynamic search-like tools", async () => {
  const codeReviewApi = createScriptedApi([null]);
  await codeReview(codeReviewApi);
  assert.deepEqual(codeReviewApi.calls[0]?.tools, EXPECTED_ADVISORY_TOOLS);
  assert.deepEqual(codeReviewApi.calls[0]?.toolHints, EXPECTED_ADVISORY_TOOL_HINTS);

  const diagnoseApi = createScriptedApi([null], "failing command");
  await diagnose(diagnoseApi);
  assert.deepEqual(diagnoseApi.calls[0]?.tools, EXPECTED_ADVISORY_TOOLS);
  assert.deepEqual(diagnoseApi.calls[0]?.toolHints, EXPECTED_ADVISORY_TOOL_HINTS);

  const refactorApi = createScriptedApi([{ target: ".", files: [], summary: "Nothing to scout." }]);
  await refactorScout(refactorApi);
  assert.deepEqual(refactorApi.calls[0]?.tools, EXPECTED_ADVISORY_TOOLS);
  assert.deepEqual(refactorApi.calls[0]?.toolHints, EXPECTED_ADVISORY_TOOL_HINTS);

  const perfApi = createScriptedApi([{ target: "startup", files: [], commands: [], summary: "No path identified." }]);
  await perfReview(perfApi);
  assert.deepEqual(perfApi.calls[0]?.tools, EXPECTED_ADVISORY_TOOLS);
  assert.deepEqual(perfApi.calls[0]?.toolHints, EXPECTED_ADVISORY_TOOL_HINTS);
});

test("code-review returns the empty report when scope is unavailable", async () => {
  const api = createScriptedApi([null]);

  const result = asReportResult(await codeReview(api));

  assert.equal(result.summary, "No changes found to review.");
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.stats, { files: 0, candidates: 0, verified: 0, kept: 0, dropped: 0 });
});

test("code-review returns the empty report when scope has no files", async () => {
  const api = createScriptedApi([
    {
      diffCommand: "git diff --no-color HEAD",
      files: [],
      summary: "No changed files.",
    },
  ]);

  const result = asReportResult(await codeReview(api));

  assert.equal(result.summary, "No changes found to review.");
  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.files, 0);
});

test("code-review verifies one candidate and passes evidence into synthesis", async () => {
  const surviving = candidate("confirmed bug", "bug");
  const api = createScriptedApi([
    {
      diffCommand: "not a diff command",
      files: ["src/example.ts"],
      summary: "One risky change.",
      conventions: "Prefer direct tests.",
    },
    { candidates: [surviving] },
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    { verdict: "CONFIRMED", evidence: ["src/example.ts:12 proves the bug"], confidence: "high" },
    report("One confirmed bug.", [finding("confirmed bug", "bug")]),
  ]);

  const result = asReportResult(await codeReview(api));
  const synthesize = api.calls.find((call) => call.label === "synthesize");

  assert.equal(result.summary, "One confirmed bug.");
  assert.equal(result.stats.candidates, 1);
  assert.equal(result.stats.verified, 1);
  assert.equal(result.stats.kept, 1);
  assert.match(synthesize?.prompt ?? "", /src\.example\.ts:12 proves the bug|src\/example\.ts:12 proves the bug/);
  assert.match(synthesize?.prompt ?? "", /confirmed bug impact/);
});

test("refactor-scout returns the empty report when no files are scoped", async () => {
  const api = createScriptedApi([
    {
      target: ".",
      files: [],
      summary: "Nothing to scout.",
    },
  ]);

  const result = asReportResult(await refactorScout(api));

  assert.equal(result.summary, "No files were identified for refactor scouting.");
  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.files, 0);
});

test("refactor-scout runs all finder agents before verifier agents", async () => {
  const opportunity = candidate("extract duplicate helper", "duplication");
  const api = createScriptedApi([
    {
      target: "src",
      files: ["src/example.ts"],
      summary: "Example module.",
      conventions: "Keep changes small.",
    },
    { candidates: [opportunity] },
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    { verdict: "PLAUSIBLE", evidence: ["Two duplicated branches."], confidence: "medium" },
    report("One refactor opportunity.", [finding("extract duplicate helper", "duplication", "medium")]),
  ]);

  const result = asReportResult(await refactorScout(api));
  const labels = api.calls.map((call) => call.label ?? "");
  const firstVerifyIndex = labels.findIndex((label) => label.startsWith("verify:"));
  const findIndexes = labels.map((label, index) => ({ label, index })).filter(({ label }) => label.startsWith("find:"));

  assert.equal(result.stats.candidates, 1);
  assert.equal(findIndexes.length, 6);
  assert.ok(firstVerifyIndex > -1, `expected verifier call in ${JSON.stringify(labels)}`);
  assert.ok(findIndexes.every(({ index }) => index < firstVerifyIndex), `expected all finders before verify: ${JSON.stringify(labels)}`);
});

test("diagnose returns the diagnostic empty report when scope is unavailable", async () => {
  const api = createScriptedApi([null], "failing command");

  const result = asReportResult(await diagnose(api));

  assert.equal(result.summary, "Diagnosis could not establish a scope.");
  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.verified, 0);
});

test("diagnose keeps refuted hypotheses out of final findings", async () => {
  const refuted = candidate("stale fixture decoy", "test-fixture");
  const confirmed = candidate("wrong branch condition", "root-cause");
  const api = createScriptedApi([
    {
      symptom: "test fails",
      commands: ["bun test"],
      files: ["src/example.ts"],
      observations: ["The failure enters the wrong branch."],
    },
    { candidates: [refuted, confirmed] },
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    { verdict: "REFUTED", evidence: ["Fixture is current."], confidence: "low" },
    { verdict: "CONFIRMED", evidence: ["Condition is inverted."], confidence: "high" },
    report("One root cause.", [finding("wrong branch condition", "root-cause")]),
  ]);

  const result = asReportResult(await diagnose(api));

  assert.equal(result.stats.candidates, 2);
  assert.equal(result.stats.verified, 2);
  assert.equal(result.stats.kept, 1);
  assert.equal(result.stats.refuted, 1);
  assert.deepEqual(
    result.findings.map((item) => item.summary),
    ["wrong branch condition"],
  );
});

test("perf-review returns the empty report when no performance files are scoped", async () => {
  const api = createScriptedApi([
    {
      target: "startup",
      files: [],
      commands: [],
      summary: "No path identified.",
    },
  ]);

  const result = asReportResult(await perfReview(api));

  assert.equal(result.summary, "No performance-relevant files were identified.");
  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.files, 0);
});

test("perf-review keeps weak measurement findings advisory", async () => {
  const measurementGap = candidate("missing startup benchmark", "measurement");
  const measurementFinding = {
    ...finding("missing startup benchmark", "measurement", "medium"),
    severity: "low" as const,
    recommendation: "Measure startup before optimizing the path.",
  };
  const api = createScriptedApi([
    {
      target: "startup",
      files: ["src/example.ts"],
      commands: ["bun run bench:startup"],
      summary: "Startup path.",
      knownMeasurements: "No current measurement.",
    },
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    emptyCandidates(),
    { candidates: [measurementGap] },
    { verdict: "PLAUSIBLE", evidence: ["No benchmark output is checked in."], confidence: "low" },
    report("Measurement gap only.", [measurementFinding]),
  ]);

  const result = asReportResult(await perfReview(api));
  const synthesize = api.calls.find((call) => call.label === "synthesize");

  assert.equal(result.stats.kept, 1);
  assert.equal(result.findings[0]?.category, "measurement");
  assert.equal(result.findings[0]?.confidence, "medium");
  assert.match(result.findings[0]?.recommendation ?? "", /Measure startup before optimizing/);
  assert.match(synthesize?.prompt ?? "", /PLAUSIBLE, measurement/);
  assert.match(synthesize?.prompt ?? "", /Prefer measurement recommendations before optimization recommendations/);
});
