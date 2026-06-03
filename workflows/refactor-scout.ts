import { Type } from "typebox";
import type { AdvisoryReport } from "../src/advisory-schema.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "refactor-scout",
  description: "Advisory-only refactor scout: scope → per-lens find → independent verify → synthesize safe refactor opportunities.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Synthesize" }],
};

const ScopeSchema = Type.Object({
  target: Type.String({ description: "Verbatim target path, module, or focus area being scouted." }),
  files: Type.Array(Type.String(), { description: "Repository-relative files in scope." }),
  summary: Type.String({ description: "One-paragraph summary of the scoped code." }),
  conventions: Type.Optional(Type.String({ description: "Relevant project conventions from AGENTS.md / CLAUDE.md / docs." })),
});

interface RefactorLens {
  label: string;
  category: string;
  text: string;
}

const REFACTOR_LENSES: RefactorLens[] = [
  { label: "duplication", category: "duplication", text: "Repeated logic, copy-pasted structures, or near-duplicate flows that could share one clearer implementation." },
  { label: "complexity", category: "complexity", text: "Oversized functions, tangled control flow, or abstractions that make local reasoning harder than necessary." },
  { label: "type-safety", category: "type-safety", text: "Weak typing, avoidable casts, unchecked shapes, or places stronger types would prevent mistakes." },
  { label: "boundaries", category: "boundary", text: "Leaky module boundaries, misplaced responsibilities, or imports that couple unrelated layers." },
  { label: "dead-code", category: "dead-code", text: "Unused, obsolete, or redundant code paths that can likely be removed safely." },
  { label: "conventions", category: "conventions", text: "Departures from project conventions, naming, dependency rules, or local idioms." },
];

const TOOLS = ["read", "bash"];
const PER_LENS = 5;

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, phase, log, progress, args } = api;
  const target = args.trim() || ".";
  const makeStats = (candidates: number, verified: number, kept: number): WorkflowRunStats => ({
    files: 0,
    candidates,
    verified,
    kept,
  });

  phase("Scope");
  const scope = await agent(
    "Establish the scope for an advisory-only refactor scout. Do not edit files.\n" +
      `Target / focus (verbatim): ${target}\n\n` +
      "Inspect repository structure, the target path or module, and relevant AGENTS.md / CLAUDE.md conventions. " +
      "Return the concrete files that should be considered, a short summary, and any conventions that affect refactor advice. " +
      `This workflow will later fan out across ${REFACTOR_LENSES.length} lenses with up to ${PER_LENS} candidates per lens. Structured output only.`,
    { phase: "Scope", label: "scope", tools: TOOLS, thinkingLevel: "medium", schema: ScopeSchema },
  );

  if (!scope || scope.files.length === 0) {
    return emptyReport(
      "No files were identified for refactor scouting.",
      ["Provide a target path, module, or subsystem to scout for refactor opportunities."],
      makeStats(0, 0, 0),
    );
  }

  progress({ type: "counter", key: "files", label: "files", value: scope.files.length });
  progress({ type: "summary", key: "files", value: scope.files.join(", ") });
  log(`${scope.files.length} files scoped for refactor scouting`);

  return emptyReport(
    `Refactor scout scoped ${scope.files.length} file(s); find/verify/synthesize stages are not implemented yet.`,
    ["Complete the planned find, verify, and synthesize stages before using this workflow."],
    { files: scope.files.length, candidates: 0, verified: 0, kept: 0 },
  );
}

function emptyReport(summary: string, nextSteps: string[], stats: WorkflowRunStats): AdvisoryReport & { stats: WorkflowRunStats } {
  return { summary, findings: [], nextSteps, stats };
}
