import { compactResults } from "../src/concurrency.ts";
import {
  MAX_RESEARCH_LANES,
  ResearchLaneResultSchema,
  ResearchPlanSchema,
  ResearchReportSchema,
  ResearchVerificationSchema,
  type ResearchClaimCandidate,
  type ResearchReport,
  type ResearchVerification,
} from "../src/research-contract.ts";
import {
  buildClaimCandidates,
  fallbackResearchReport,
  normalizeResearchLanes,
  sanitizeLaneResults,
  sanitizeResearchReport,
  sanitizeVerification,
  unavailableResearchReport,
  unavailableVerification,
} from "../src/research-evidence.ts";
import { WorkflowToolHintUnavailableError } from "../src/tool-capabilities.ts";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "research",
  description: "Source-grounded external research: decompose → gather direct-page evidence → independently verify claims → cited synthesis.",
  phases: [{ title: "Plan" }, { title: "Gather" }, { title: "Verify" }, { title: "Synthesize" }],
};

const EXTERNAL_TOOLS: string[] = [];
const EXTERNAL_TOOL_HINTS = ["external-search"] as const;

export default async function run(api: WorkflowApi): Promise<ResearchReport> {
  const { agent, parallel, phase, log, progress, args } = api;
  const question = args.trim();
  if (!question) return unavailableResearchReport("empty-question");

  phase("Plan");
  let plan;
  try {
    plan = await agent(
      `Plan bounded, source-grounded research for the user's question and any scope constraints embedded in it.\n\n` +
        `Question and constraints (verbatim):\n${question}\n\n` +
        `Create at most ${MAX_RESEARCH_LANES} non-overlapping lanes. Each lane needs a stable short id, title, objective, and 1-4 concrete search queries. ` +
        "Separate primary-source discovery, current status, counterevidence, or jurisdiction/timeframe only when relevant. " +
        "Do not claim exhaustive coverage. Structured output only.",
      {
        phase: "Plan",
        label: "plan",
        tools: EXTERNAL_TOOLS,
        toolHints: EXTERNAL_TOOL_HINTS,
        requireToolHints: true,
        profile: "medium",
        resume: "off",
        schema: ResearchPlanSchema,
      },
    );
  } catch (error) {
    if (error instanceof WorkflowToolHintUnavailableError) return unavailableResearchReport("missing-capability");
    throw error;
  }

  if (!plan) return unavailableResearchReport("no-evidence");
  const lanes = normalizeResearchLanes(plan);
  if (lanes.length === 0) return unavailableResearchReport("no-evidence");
  progress({ type: "counter", key: "research.lanes", label: "research lanes", value: lanes.length });
  progress({ type: "summary", key: "research.question", value: question });

  phase("Gather");
  const gathered = compactResults(
    await parallel(
      lanes.map((lane) => async () => {
        const result = await agent(
          `Research one bounded lane using only installed external web-search, browsing, or URL-extraction tools.\n\n` +
            `Question: ${question}\n` +
            `Scope constraints: ${plan.scopeConstraints.join("; ") || "(none)"}\n` +
            `Lane id: ${lane.id}\nLane: ${lane.title}\nObjective: ${lane.objective}\n` +
            `Queries:\n${lane.queries.map((query) => `- ${query}`).join("\n")}\n\n` +
            "Open the supporting pages instead of citing a search-results page. Prefer primary and authoritative sources; use independent sources when useful. " +
            "Return concrete claims with importance, whether each page supports or conflicts with the claim, a short passage or precise paraphrase, and the exact page title and URL. " +
            "State evidence gaps. Never invent a URL or claim that the opened page does not support. Structured output only.",
          {
            phase: "Gather",
            label: `gather:${lane.id}`,
            tools: EXTERNAL_TOOLS,
            toolHints: EXTERNAL_TOOL_HINTS,
            requireToolHints: true,
            profile: "small",
            resume: "off",
            schema: ResearchLaneResultSchema,
          },
        );
        if (!result) return null;
        progress({ type: "counter_delta", key: "research.evidence", label: "evidence items", delta: result.evidence.length });
        progress({
          type: "lane_item",
          lane: "Research lanes",
          title: lane.title,
          subtitle: `${result.evidence.length} evidence item(s)`,
          status: result.evidence.length > 0 ? "success" : "warning",
          details: result.gaps.join("; ") || lane.objective,
        });
        return result;
      }),
    ),
  );

  const laneResults = sanitizeLaneResults(gathered);
  const candidates = buildClaimCandidates(laneResults);
  if (candidates.length === 0) return unavailableResearchReport("no-evidence");
  progress({ type: "counter", key: "research.claims", label: "claims to verify", value: candidates.length });
  log(`${candidates.length} bounded claim(s) selected for independent verification`);

  phase("Verify");
  const verificationResults = await parallel(
    candidates.map((candidate, index) => async () => {
      const result = await agent(verificationPrompt(question, candidate), {
        phase: "Verify",
        label: `verify:${index + 1}`,
        tools: EXTERNAL_TOOLS,
        toolHints: EXTERNAL_TOOL_HINTS,
        requireToolHints: true,
        profile: "medium",
        resume: "off",
        schema: ResearchVerificationSchema,
      });
      return result ? sanitizeVerification(result, candidate) : null;
    }),
  );
  const verifications = verificationResults.map((result, index) => result ?? unavailableVerification(candidates[index]!));
  for (const verification of verifications) {
    progress({ type: "counter_delta", key: `research.${verification.verdict.toLowerCase()}`, label: verification.verdict.toLowerCase(), delta: 1 });
  }
  const synthesisInputs = verifications.filter((verification) => verification.verdict !== "REJECTED");

  phase("Synthesize");
  const synthesis = await agent(
    `Answer the research question using only the independently verified handoff below.\n\n` +
      `Question: ${question}\nScope constraints: ${plan.scopeConstraints.join("; ") || "(none)"}\n\n` +
      `Verified claims JSON:\n${JSON.stringify(synthesisInputs)}\n\n` +
      "Keep SUPPORTED claims, CONFLICTED evidence, UNCERTAIN claims, and model INFERENCE in their separate fields. Exclude REJECTED claims. " +
      "Copy each verified claim string exactly so its citations remain bound to that claim during validation. " +
      "Every supported or conflicting claim must cite exact title/URL objects from its verification; do not add URLs, cite search-results pages, or turn inference into fact. " +
      "Answer concisely, disclose limited coverage, and provide useful next steps. Structured output only.",
    {
      phase: "Synthesize",
      label: "synthesize",
      tools: [],
      profile: "medium",
      resume: "off",
      schema: ResearchReportSchema,
    },
  );

  return sanitizeResearchReport(
    synthesis ?? fallbackResearchReport(synthesisInputs, "The model did not return a structured synthesis."),
    synthesisInputs,
  );
}

function verificationPrompt(question: string, candidate: ResearchClaimCandidate): string {
  return `Independently verify one important research claim using installed external web-search, browsing, or URL-extraction tools.\n\n` +
    `Question: ${question}\nClaim: ${candidate.claim}\nImportance: ${candidate.importance}\n\n` +
    `Gather-stage evidence (context only; do not treat it as verified):\n${JSON.stringify(candidate.evidence)}\n\n` +
    "Search independently and open direct supporting pages. Prefer primary/authoritative sources and actively look for credible counterevidence. " +
    "Return SUPPORTED only when direct pages substantiate the claim, CONFLICTED when credible sources disagree, UNCERTAIN when evidence is insufficient, " +
    "INFERENCE when the conclusion is reasoned rather than directly stated, or REJECTED when evidence refutes it. " +
    "Include exact page titles and direct HTTP(S) URLs, never search-results URLs. Structured output only.";
}
