import assert from "node:assert/strict";
import { test } from "bun:test";
import research from "../.pi/extensions/pi-workflow-engine/workflows/research.ts";
import { parallel, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import {
  dedupeSources,
  sanitizeResearchReport,
  sanitizeVerification,
} from "../.pi/extensions/pi-workflow-engine/src/research-evidence.ts";
import type {
  ResearchClaimCandidate,
  ResearchVerification,
} from "../.pi/extensions/pi-workflow-engine/src/research-contract.ts";
import { WorkflowToolHintUnavailableError } from "../.pi/extensions/pi-workflow-engine/src/tool-capabilities.ts";
import type { AgentOptions, WorkflowApi, WorkflowProgressEvent } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

interface AgentCall {
  readonly prompt: string;
  readonly options: AgentOptions | undefined;
}

interface ScriptedApi extends WorkflowApi {
  readonly calls: AgentCall[];
  readonly phases: string[];
  readonly events: WorkflowProgressEvent[];
}

function scriptedApi(responses: readonly unknown[], args: string): ScriptedApi {
  const queue = [...responses];
  const calls: AgentCall[] = [];
  const phases: string[] = [];
  const events: WorkflowProgressEvent[] = [];
  const agent = (async (prompt: string, options?: AgentOptions) => {
    calls.push({ prompt, options });
    if (queue.length === 0) throw new Error(`No scripted response for ${options?.label ?? "agent"}`);
    const response = queue.shift();
    if (response instanceof Error) throw response;
    return response;
  }) as WorkflowApi["agent"];
  return {
    calls,
    phases,
    events,
    agent,
    workflow: async () => {
      throw new Error("sub-workflows are disabled in this fixture");
    },
    parallel,
    pipeline,
    phase: (title) => phases.push(title),
    log: () => {},
    progress: (event) => events.push(event),
    args,
    cwd: process.cwd(),
    budget: { total: null, spent: () => 0, remaining: () => Infinity },
    signal: undefined,
  };
}

test("research returns actionable no-LLM results for empty questions and missing external tools", async () => {
  const empty = scriptedApi([], "   ");
  const emptyResult = await research(empty);
  assert.match(emptyResult.answer, /No research question/);
  assert.equal(empty.calls.length, 0);

  const missing = scriptedApi(
    [new WorkflowToolHintUnavailableError(["external-search"])],
    "What changed in the specification?",
  );
  const missingResult = await research(missing);
  assert.match(missingResult.answer, /no installed external web-search or URL-extraction tool/i);
  assert.match(missingResult.nextSteps[0] ?? "", /Install or enable/);
  assert.equal(missing.calls.length, 1);
  assert.deepEqual(missing.calls[0]?.options?.toolHints, ["external-search"]);
  assert.equal(missing.calls[0]?.options?.requireToolHints, true);
  assert.equal(missing.calls[0]?.options?.profile, "medium");
});

test("research source normalization deduplicates direct pages and rejects search-results URLs", () => {
  assert.deepEqual(
    dedupeSources([
      { title: "Specification", url: "https://example.com/spec/?utm_source=test#section" },
      { title: "Specification duplicate", url: "https://example.com/spec" },
      { title: "Google results", url: "https://www.google.com/search?q=specification" },
    ]),
    [{ title: "Specification", url: "https://example.com/spec" }],
  );
});

test("verification cannot mark a claim supported when only search-results citations survive", () => {
  const candidate: ResearchClaimCandidate = {
    claim: "The specification changed.",
    importance: "high",
    evidence: [],
  };
  const verification: ResearchVerification = {
    claim: "A different claim invented by the verifier.",
    verdict: "SUPPORTED",
    explanation: "The search page mentions it.",
    sources: [{ title: "Search results", url: "https://www.google.com/search?q=specification" }],
  };

  assert.deepEqual(sanitizeVerification(verification, candidate), {
    claim: candidate.claim,
    verdict: "UNCERTAIN",
    explanation: "The search page mentions it.",
    sources: [],
  });
});

test("final citation validation stays bound to the matching claim and verdict", () => {
  const sourceA = { title: "Source A", url: "https://example.com/a" };
  const sourceB = { title: "Source B", url: "https://example.com/b" };
  const result = sanitizeResearchReport({
    answer: "Claim A is supported.",
    supportedClaims: [{ claim: "Claim A", explanation: "Wrong citation.", citations: [sourceB] }],
    conflictingEvidence: [],
    uncertainties: [],
    inferences: [],
    sources: [sourceA, sourceB],
    limitations: [],
    nextSteps: [],
  }, [
    { claim: "Claim A", verdict: "SUPPORTED", explanation: "Supported by A.", sources: [sourceA] },
    { claim: "Claim B", verdict: "UNCERTAIN", explanation: "Only B discusses it.", sources: [sourceB] },
  ]);

  assert.deepEqual(result.supportedClaims, []);
  assert.deepEqual(result.uncertainties, [{
    claim: "Claim A",
    explanation: "Wrong citation. No verified direct-page citation survived validation.",
    citations: [],
  }]);
});

test("research preserves citation context through verification and filters rejected claims before synthesis", async () => {
  const api = scriptedApi([
    {
      scopeConstraints: ["Use current primary sources"],
      lanes: [{ id: "status", title: "Current status", objective: "Find the current specification.", queries: ["current specification"] }],
    },
    {
      laneId: "status",
      evidence: [
        {
          claim: "The specification changed.",
          importance: "high",
          stance: "supports",
          evidence: "The changelog lists a new requirement.",
          source: { title: "Official specification", url: "https://example.com/spec?utm_source=search#changes" },
        },
        {
          claim: "A rejected claim.",
          importance: "medium",
          stance: "supports",
          evidence: "A weak page asserts it.",
          source: { title: "Weak page", url: "https://example.net/weak" },
        },
      ],
      gaps: [],
    },
    {
      claim: "The specification changed.",
      verdict: "SUPPORTED",
      explanation: "The official changelog confirms it.",
      sources: [{ title: "Official specification", url: "https://example.com/spec" }],
    },
    {
      claim: "A rejected claim.",
      verdict: "REJECTED",
      explanation: "No authoritative source supports it.",
      sources: [{ title: "Weak page", url: "https://example.net/weak" }],
    },
    {
      answer: "The specification changed.",
      supportedClaims: [{
        claim: "The specification changed.",
        explanation: "The official changelog confirms it.",
        citations: [{ title: "Official specification", url: "https://example.com/spec?utm_medium=workflow" }],
      }],
      conflictingEvidence: [],
      uncertainties: [],
      inferences: [],
      sources: [{ title: "Official specification", url: "https://example.com/spec" }],
      limitations: ["One primary source was available."],
      nextSteps: ["Monitor the official changelog."],
    },
  ], "What changed? Use current primary sources.");

  const result = await research(api);
  const gather = api.calls.find((call) => call.options?.label === "gather:status");
  const verifier = api.calls.find((call) => call.options?.label === "verify:1");
  const synthesis = api.calls.find((call) => call.options?.label === "synthesize");

  assert.deepEqual(api.phases, ["Plan", "Gather", "Verify", "Synthesize"]);
  assert.match(gather?.prompt ?? "", /supporting pages instead of citing a search-results page/i);
  assert.match(verifier?.prompt ?? "", /Official specification/);
  assert.match(verifier?.prompt ?? "", /https:\/\/example\.com\/spec/);
  assert.match(synthesis?.prompt ?? "", /The official changelog confirms it/);
  assert.match(synthesis?.prompt ?? "", /Copy each verified claim string exactly/);
  assert.doesNotMatch(synthesis?.prompt ?? "", /A rejected claim/);
  assert.ok(api.calls.every((call) => call.options?.profile === "small" || call.options?.profile === "medium"));
  assert.ok(api.calls.every((call) => call.options?.resume === "off"));
  assert.deepEqual(result.sources, [{ title: "Official specification", url: "https://example.com/spec" }]);
  assert.deepEqual(result.supportedClaims[0]?.citations, [{ title: "Official specification", url: "https://example.com/spec" }]);
});
