import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ResearchReport } from "../.pi/extensions/pi-workflow-engine/src/research-contract.ts";
import type { WorkflowUsageSnapshot } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { renderWorkflowResultLines, type WorkflowResultView } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-result-renderer.ts";
import { renderWorkflowToolResult, workflowToolCallLine } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-tool-renderer.ts";
import { createReviewReportFixture, createTestTheme } from "./fixtures/theme.ts";

const plain = stripVTControlCharacters;

const theme = createTestTheme();
const hints = { triage: "ctrl+alt+t", inspect: "ctrl+alt+i", expand: "ctrl+o" };
const RUN_ID = "3cfb22c2-5434-4359-ad9f-67ed0af1dabb";

const totals = {
  input: 30_000, output: 1_200, cacheRead: 4_000, cacheWrite: 0, totalTokens: 35_200,
  coverage: { input: "complete", output: "complete", cacheRead: "complete", cacheWrite: "complete" },
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} as const;
const usage: WorkflowUsageSnapshot = {
  agents: [{ label: "find", assistantMessages: 1, usage: totals }, { label: "verify", assistantMessages: 1, usage: totals }],
  totals,
  assistantMessages: 2,
};

/** Report order medium, low, high, so display order proves the severity sort. */
function reviewReport() {
  const [high, medium, low] = createReviewReportFixture().findings;
  return {
    summary: "Concurrent callers can observe the cache before the first writer finishes.",
    findings: [medium, low, high],
    nextSteps: ["Guard the publish with the abort signal."],
    stats: { files: 3, candidates: 4, verified: 3, kept: 3, dropped: 0, refuted: 1 },
  };
}

function incompleteReport() {
  return {
    ...reviewReport(),
    summary: "Incomplete review: 2 branch(es) failed. 3 finding(s) available; no clean conclusion is possible.",
    status: "incomplete" as const,
    coverage: [
      { stage: "Find", expected: 5, completed: 4, failed: 1, failures: [{ branch: "error-paths", reason: "provider failed" }] },
      { stage: "Verify", expected: 3, completed: 3, failed: 0, failures: [] },
    ],
    gaps: ["Find/error-paths: provider failed", "Find/edge-cases: timed out"],
  };
}

const researchReport: ResearchReport = {
  answer: "Tool results render through width-aware components.",
  supportedClaims: [
    { claim: "renderResult receives the expanded flag.", explanation: "Passed on every render.", citations: [{ title: "Extensions guide", url: "https://www.pi.dev/docs/extensions", publishedAt: "2026-09-14" }] },
    { claim: "Lines must fit the offered width.", explanation: "Overflow corrupts the screen.", citations: [{ title: "TUI reference", url: "https://docs.example.dev/tui" }] },
    { claim: "Custom messages draw their own background.", explanation: "The renderer owns styling.", citations: [] },
    { claim: "A fourth supported claim.", explanation: "Only shown expanded.", citations: [] },
  ],
  conflictingEvidence: [],
  uncertainties: [{ claim: "Hyperlinks survive tmux.", explanation: "Depends on terminal features.", citations: [] }],
  inferences: [],
  sources: [{ title: "Extensions guide", url: "https://www.pi.dev/docs/extensions", publishedAt: "2026-09-14" }],
  limitations: ["Only official docs were consulted."],
  nextSteps: ["Read the TUI reference."],
};

function view(name: string, result: unknown, extra: Partial<WorkflowResultView> = {}): WorkflowResultView {
  return { name, result, usage, runId: RUN_ID, startedAt: 1_000, completedAt: 5_200, ...extra };
}

function render(input: WorkflowResultView, expanded: boolean, width = 120): string[] {
  return renderWorkflowResultLines(input, expanded, width, theme, hints).map(plain);
}

test("every result kind fits each line to the offered width, collapsed and expanded", () => {
  const views = [
    view("code-review", reviewReport()),
    view("code-review", incompleteReport()),
    view("code-review", { summary: "Clean.", findings: [], nextSteps: [] }),
    view("research", researchReport),
    view("repo-scan", { summary: "Scanned three areas. ".repeat(20), areas: ["a".repeat(300)] }),
    view("code-review", { summary: "Workflow failed: provider rejected the request" }, { background: true, status: "failed" }),
  ];
  for (const width of [140, 90, 60, 40]) {
    for (const input of views) {
      for (const expanded of [false, true]) {
        const lines = renderWorkflowResultLines(input, expanded, width, theme, hints);
        const over = lines.filter((line) => visibleWidth(line) > width);
        assert.deepEqual(over, [], `${input.name} expanded=${expanded} width=${width}`);
      }
    }
  }
});

test("collapsed review results list findings most severe first and hide zero counts", () => {
  const lines = render(view("code-review", reviewReport()), false);
  const text = lines.join("\n");

  assert.match(lines[0] ?? "", /^✓ code-review {2}3 findings · 1 high · 1 medium · 1 low\s+4s · ↑34k ↓1.2k$/);
  const rows = lines.filter((line) => /^ {2}(HIGH|MED|LOW)/.test(line)).map((line) => line.trim().slice(0, 4).trim());
  assert.deepEqual(rows, ["HIGH", "MED", "LOW"]);
  assert.doesNotMatch(text, /\b0 (dropped|failed)|\$0\b|dropped 0/);
  assert.match(lines.at(-1) ?? "", /ctrl\+alt\+t triage · ctrl\+alt\+i inspect · ctrl\+o expand · run 3cfb22c2$/);
  assert.doesNotMatch(text, new RegExp(RUN_ID));
});

test("the triage hint is offered only for code-review results with findings", () => {
  const scout = render(view("refactor-scout", reviewReport()), false).join("\n");
  const clean = render(view("code-review", { summary: "Clean.", findings: [], nextSteps: [] }), false);
  assert.doesNotMatch(scout, /triage/);
  assert.match(clean[0] ?? "", /^✓ code-review {2}no findings/);
  assert.doesNotMatch(clean.join("\n"), /triage/);
});

test("incomplete reviews warn in the header and keep the first gap visible collapsed", () => {
  const lines = render(view("code-review", incompleteReport()), false);
  assert.match(lines[0] ?? "", /^⚠ code-review {2}incomplete · 1 of 5 finders failed · 3 findings/);
  assert.ok(lines.some((line) => /✗ Find\/error-paths: provider failed · \+1 more/.test(line)));
  assert.doesNotMatch(lines.join("\n"), /✓|no findings/);
  assert.doesNotMatch(lines.join("\n"), /Incomplete review:/, "the collapsed header already says what the generated summary says");
  assert.match(render(view("code-review", incompleteReport()), true).join("\n"), /Incomplete review: 2 branch\(es\) failed/);

  const empty = render(view("code-review", { ...incompleteReport(), findings: [] }), false);
  assert.match(empty[0] ?? "", /^⚠ code-review {2}incomplete · 1 of 5 finders failed · no verified findings/);
});

test("expanded reviews replace rows with details and add coverage, funnel and the full run id", () => {
  const text = render(view("code-review", incompleteReport()), true).join("\n");
  const [high] = createReviewReportFixture().findings;

  assert.equal(text.split("Documentation omits the new flag.").length - 1, 1, "each summary appears once");
  assert.match(text, /Impact {4}A final retry is skipped\./);
  assert.match(text, /Coverage {2}7 of 8 branches complete · Find 4 of 5 \(1 failed\)/);
  assert.match(text, /Gaps {6}✗ Find\/error-paths: provider failed\n {12}✗ Find\/edge-cases: timed out/);
  assert.match(text, /Funnel {4}3 files → 4 candidates → 3 verified → 3 kept · 1 refuted/);
  assert.match(text, /Follow-up • Guard the publish with the abort signal\./);
  assert.match(text, new RegExp(`Run {7}${RUN_ID} · 2 agents`));
  assert.match(text, /ctrl\+o collapse$/);
  assert.ok(high && text.includes(high.recommendation));
});

test("research results number claims with citations that match the source list", () => {
  const collapsed = render(view("research", researchReport), false);
  assert.match(collapsed[0] ?? "", /^✓ research {2}4 supported · 1 uncertain · 2 sources/);
  assert.match(collapsed.join("\n"), /Tool results render through width-aware components\./);
  assert.match(collapsed.join("\n"), /1\. renderResult receives the expanded flag\. \[1\]/);
  assert.match(collapsed.join("\n"), /2\. Lines must fit the offered width\. \[2\]/);
  assert.match(collapsed.join("\n"), /\+2 more claims/);
  assert.doesNotMatch(collapsed.join("\n"), /A fourth supported claim|Sources|Limitations/);

  const expanded = render(view("research", researchReport), true).join("\n");
  assert.match(expanded, /Supported claims 4/);
  assert.match(expanded, /Uncertain 1\n {2}1\. Hyperlinks survive tmux\./);
  assert.doesNotMatch(expanded, /Conflicting|Inferences/);
  assert.match(expanded, /\[1\] Extensions guide · pi\.dev · 2026-09-14/);
  assert.match(expanded, /\[2\] TUI reference · docs\.example\.dev/);
  assert.match(expanded, /Limitations\n {2}• Only official docs were consulted\./);
  assert.match(expanded, /Next steps\n {2}• Read the TUI reference\./);
});

test("research without verified claims warns and points at the next step", () => {
  const lines = render(view("research", { ...researchReport, supportedClaims: [], uncertainties: [], sources: [] }), false);
  assert.match(lines[0] ?? "", /^⚠ research {2}no verified claims/);
  assert.ok(lines.some((line) => /→ Read the TUI reference\./.test(line)));
});

test("generic results show the summary collapsed and the remaining JSON only when expanded", () => {
  const result = { summary: "Scanned three areas.", areas: ["engine", "ui"] };
  const collapsed = render(view("repo-scan", result), false);
  assert.match(collapsed[0] ?? "", /^✓ repo-scan {2}done · 2 agents\s+4s · ↑34k ↓1.2k$/);
  assert.doesNotMatch(collapsed.join("\n"), /"areas"/);

  const expanded = render(view("repo-scan", result), true).join("\n");
  assert.match(expanded, /"areas": \[/);
  assert.doesNotMatch(expanded, /"summary"/);

  const noSummary = render(view("repo-scan", { areas: [], risks: [] }), false).join("\n");
  assert.match(noSummary, /result · areas, risks/);
});

test("background runs that ended without a result point at run history", () => {
  const lines = render(view("code-review", { summary: "Workflow paused: host exited" }, { background: true, status: "paused" }), false);
  assert.match(lines[0] ?? "", /^⚠ code-review {2}paused/);
  assert.match(lines.at(-1) ?? "", /\/workflow:runs resume · ctrl\+alt\+i inspect · ctrl\+o expand · run 3cfb22c2 · background$/);
});

test("the workflow tool call names the workflow, its detail and tags", () => {
  const named = plain(workflowToolCallLine({ name: "code-review", args: "HEAD~3", background: true }, 80, theme));
  assert.equal(named, "▸ workflow code-review · HEAD~3 (background)");

  const script = `export const meta = { name: "repo-scan", description: "Scan three areas in parallel and synthesise" };\nexport default async function () { return 1; }`;
  const inline = plain(workflowToolCallLine({ script }, 44, theme));
  assert.match(inline, /^▸ workflow repo-scan · Scan three/);
  assert.ok(visibleWidth(inline) <= 44);

  const streaming = plain(workflowToolCallLine({ script: "export const meta = { name: \"repo" }, 80, theme));
  assert.equal(streaming, "▸ workflow inline");
});

test("the workflow tool row shows a live marker, a background receipt, and errors", () => {
  const args = { name: "code-review" };
  const partial = renderWorkflowToolResult({ content: [], details: undefined }, { expanded: false, isPartial: true }, theme, args, hints);
  assert.deepEqual(partial.render(80).map(plain), ["● running code-review"]);

  const receipt = renderWorkflowToolResult(
    { content: [{ type: "text", text: "started" }], details: { background: true, state: "running", name: "code-review", runId: RUN_ID } },
    { expanded: false, isPartial: false }, theme, args, hints,
  ).render(80).map(plain);
  assert.match(receipt[0] ?? "", /^◆ code-review {2}started in background\s+run 3cfb22c2$/);
  assert.match(receipt[1] ?? "", /\/workflow:runs manage/);

  const error = renderWorkflowToolResult(
    { content: [{ type: "text", text: "Unknown workflow \"nope\". Available: code-review" }], details: { error: "unknown_workflow" } },
    { expanded: false, isPartial: false }, theme, args, hints,
  ).render(80).map(plain);
  assert.deepEqual(error, ["✗ Unknown workflow \"nope\". Available: code-review"]);
});
