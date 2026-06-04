import { Type } from "typebox";
import {
  AdvisoryCandidatesSchema,
  AdvisoryReportSchema,
  AdvisoryVerdictSchema,
  type AdvisoryCandidate,
  type AdvisoryVerdict,
} from "../src/advisory-schema.ts";
import {
  backfillAdvisoryFindings,
  formatEvidence,
  formatLocation,
  normalizePath,
  primaryLocation,
  recordVerdictProgress,
  verdictConfidence,
} from "../src/workflow-advisory-utils.ts";
import { captureDiff } from "../src/diff-capture.ts";
import type { WorkflowApi, WorkflowMeta, WorkflowRunStats } from "../src/types.ts";

export const meta: WorkflowMeta = {
  name: "code-review",
  description: "Fan-out review of the branch's open PR (or branch vs main): scope → per-angle find → independent verify → synthesize.",
  phases: [{ title: "Scope" }, { title: "Find" }, { title: "Verify" }, { title: "Synthesize" }],
};

// ─── Schemas (the contracts that make orchestration plain code) ───
const ScopeSchema = Type.Object({
  diffCommand: Type.String({ description: "Exact git command that produces the review diff" }),
  files: Type.Array(Type.String(), { description: "Changed file paths" }),
  summary: Type.String({ description: "One-paragraph summary of the change" }),
  conventions: Type.Optional(Type.String({ description: "Relevant CLAUDE.md / project conventions" })),
});

type Candidate = AdvisoryCandidate;

interface Angle {
  label: string;
  kind: "bug" | "cleanup";
  text: string;
}
interface Verified extends Candidate {
  verdict: AdvisoryVerdict["verdict"];
  evidence: string[];
  kind: "bug" | "cleanup";
}

// The review lenses — this is the part you customise to your codebase's real failure modes.
const ANGLES: Angle[] = [
  { label: "logic-bugs", kind: "bug", text: "Off-by-one errors, wrong conditionals, incorrect return values, broken control flow." },
  { label: "error-paths", kind: "bug", text: "Unhandled errors, swallowed exceptions, missing awaits, partial failure leaving inconsistent state." },
  { label: "edge-cases", kind: "bug", text: "Empty/null inputs, boundary values, concurrency races, resource leaks." },
  { label: "simplification", kind: "cleanup", text: "Dead code, needless complexity, duplicated logic, clearer equivalents." },
  { label: "conventions", kind: "cleanup", text: "Violations of the project conventions noted in scope (naming, idioms, banned patterns)." },
];

const TOOLS = ["read", "bash"];
const PER_ANGLE = 6;
const DIFF_EMBED_CAP = 60_000;

/** Parse a unified diff into the set of added/changed new-file line numbers per file. */
export function changedLines(diff: string): Map<string, Set<number>> {
  const byFile = new Map<string, Set<number>>();
  let file: string | null = null;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const path = raw.slice(4).trim();
      file = path === "/dev/null" ? null : normalizePath(path);
      if (file && !byFile.has(file)) byFile.set(file, new Set());
    } else if (raw.startsWith("@@")) {
      const match = /\+(\d+)/.exec(raw);
      newLine = match ? Number(match[1]) : 0;
    } else if (file === null || raw.startsWith("---") || raw.startsWith("\\")) {
      // file header, deletion, or "No newline" marker — record nothing
    } else if (raw.startsWith("+")) {
      byFile.get(file)!.add(newLine++);
    } else if (!raw.startsWith("-")) {
      newLine++; // context line advances the new-file counter; deletions do not
    }
  }
  return byFile;
}

/** Is a finding inside the diff? File-level findings count if the file changed; ±1 line of fuzz. */
export function inDiff(changed: Map<string, Set<number>>, file: string, line?: number): boolean {
  const set = changed.get(normalizePath(file));
  if (!set) return false;
  if (line == null) return true;
  return set.has(line) || set.has(line - 1) || set.has(line + 1);
}

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, parallel, phase, log, progress, args, cwd, signal } = api;
  const target = args.trim();
  let fileCount = 0;
  let rawCandidateCount = 0;
  let droppedCandidateCount = 0;
  const makeStats = (verified: number, kept: number): WorkflowRunStats => ({
    files: fileCount,
    candidates: rawCandidateCount,
    verified,
    kept,
    dropped: droppedCandidateCount,
  });

  // ─── Phase 0: Scope ───
  phase("Scope");
  const scope = await agent(
    "Establish the scope of a code review.\n" +
      (target
        ? `Target / instructions (verbatim): "${target}". If it names a PR number, branch, ref range, or files, build the matching diff command (use 'gh pr diff <number>' for a PR). Otherwise use the default selection below.\n`
        : "No explicit target — select the diff to review using the default below.\n") +
      "Default selection — run commands to decide, falling through until you get a NON-EMPTY diff:\n" +
      "1. Get the current branch: `git branch --show-current`.\n" +
      "2. Check for an OPEN GitHub PR for this branch: `gh pr list --head <branch> --state open --json number,title`. " +
      "If one exists, the diff command is `gh pr diff <number>` — note the PR number and title in the summary.\n" +
      "3. If there is no open PR (or `gh` is unavailable / there is no GitHub remote), diff the branch against its base: " +
      "prefer `git diff main...HEAD`, then `git diff master...HEAD`, then `git diff HEAD~1`. " +
      "If the branch itself is main/master, use `git diff HEAD~1`.\n" +
      "4. Run the chosen command to confirm the diff is non-empty.\n\n" +
      "Then: list the changed files, summarize the change in one paragraph (mention the PR if one was found), " +
      "and read any relevant CLAUDE.md noting conventions a reviewer should know.\n" +
      "Return diffCommand exactly as a reviewer should run it. Structured output only.",
    { phase: "Scope", label: "scope", tools: TOOLS, thinkingLevel: "medium", schema: ScopeSchema },
  );

  if (!scope) {
    return { summary: "No changes found to review.", findings: [], nextSteps: ["Provide a PR, ref range, or changed files to review."], stats: makeStats(0, 0) };
  }

  fileCount = scope.files.length;
  progress({ type: "summary", key: "files", value: scope.files.join(", ") || "(none)" });
  progress({ type: "summary", key: "diffCommand", value: scope.diffCommand });
  progress({ type: "counter", key: "files", label: "files", value: fileCount });

  if (scope.files.length === 0) {
    return { summary: "No changes found to review.", findings: [], nextSteps: ["Provide a PR, ref range, or changed files to review."], stats: makeStats(0, 0) };
  }
  log(`${scope.files.length} changed files`);

  // Capture the diff once, deterministically, so findings can be bounded to changed lines in code.
  let changed: Map<string, Set<number>> | null = null;
  let diffText = "";
  const capturedDiff = await captureDiff(scope.diffCommand, { cwd, signal, timeoutMs: 30_000, maxBufferBytes: 16 << 20 });
  if (capturedDiff.ok) {
    diffText = capturedDiff.stdout;
    changed = changedLines(diffText);
    progress({ type: "summary", key: "diffBytes", value: capturedDiff.bytes });
  } else {
    log(`diff capture failed (${capturedDiff.error ?? "unknown error"}) — reviewing without the line gate`);
  }

  const diffBlock = diffText
    ? `\n## Diff (review is bounded to these changed lines)\n\`\`\`diff\n${
        diffText.length > DIFF_EMBED_CAP
          ? `${diffText.slice(0, DIFF_EMBED_CAP)}\n... (truncated — run \`${scope.diffCommand}\` for the full diff)`
          : diffText
      }\n\`\`\`\n`
    : "";

  const scopeBlock =
    `## Diff command\n${scope.diffCommand}\n\n## Changed files\n${scope.files.map((file) => `- ${file}`).join("\n")}\n\n` +
    `## Summary\n${scope.summary}\n\n## Conventions\n${scope.conventions ?? "(none noted)"}\n` +
    diffBlock +
    (target ? `\n## User instructions (verbatim)\n${target}\n` : "");

  // Dedup after all finders complete so verifier agents cannot consume the global cap before full candidate discovery.
  const seen = new Set<string>();
  const dedupKey = (candidate: Candidate): string => {
    const location = primaryLocation(candidate);
    const lineKey = location.line != null ? Math.round(location.line / 5) * 5 : candidate.summary.slice(0, 40).toLowerCase();
    return `${normalizePath(location.file)}:${lineKey}`;
  };

  // ─── Find barrier → dedup → Verify ───
  phase("Find");
  const perAngle = await parallel(
    ANGLES.map((angle) => async () => {
      const found = await agent(
        `## Code-review finder — ${angle.label}\n\n${scopeBlock}\n` +
          `Review the change through ONLY this lens:\n${angle.text}\n` +
          "Only flag issues on lines that are part of the diff above (run the diff command if it is not shown). " +
          "You may read surrounding files for context, but never report issues in unchanged code. " +
          `Surface up to ${PER_ANGLE} candidates. Use category exactly "${angle.kind}". Each candidate must include a one-line summary, ` +
          "locations with the changed file and a line that appears in the diff, and impact describing the concrete failure or maintenance scenario. " +
          "Pass through anything with a nameable impact — a separate verifier judges them next. Structured output only.",
        { phase: "Find", label: `find:${angle.label}`, tools: TOOLS, thinkingLevel: "low", schema: AdvisoryCandidatesSchema },
      );
      const raw = (found?.candidates ?? []).slice(0, PER_ANGLE);
      rawCandidateCount += raw.length;
      progress({ type: "counter_delta", key: "candidates", label: "candidates", delta: raw.length });
      const gate = changed;
      const bounded = gate ? raw.filter((candidate) => inDiff(gate, primaryLocation(candidate).file, primaryLocation(candidate).line)) : raw;
      const dropped = raw.length - bounded.length;
      if (dropped > 0) {
        droppedCandidateCount += dropped;
        progress({ type: "counter_delta", key: "dropped", label: "dropped", delta: dropped });
      }
      if (gate && dropped > 0) {
        log(`find:${angle.label}: dropped ${dropped} out-of-diff candidate(s)`);
      }
      for (const candidate of bounded) {
        progress({
          type: "lane_item",
          lane: "Candidates",
          title: candidate.summary,
          subtitle: formatLocation(candidate),
          status: "pending",
          details: candidate.impact,
        });
      }
      return { angle, candidates: bounded };
    }),
  );

  const novel = perAngle.flatMap(({ angle, candidates }) =>
    candidates
      .filter((candidate) => {
        const key = dedupKey(candidate);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((candidate) => ({ angle, candidate })),
  );

  phase("Verify");
  const verdicts = await parallel(
    novel.map(({ angle, candidate }) => async (): Promise<Verified | null> => {
      const location = primaryLocation(candidate);
      const judged = await agent(
        `## Code-review verifier\n\n${scopeBlock}\n## Candidate\n` +
          `Location: ${formatLocation(candidate)}\n` +
          `Category: ${candidate.category}\nSummary: ${candidate.summary}\nImpact: ${candidate.impact}\n\n` +
          "Run the diff command, read the relevant file(s), and return exactly one verdict (CONFIRMED / PLAUSIBLE / REFUTED) " +
          "with evidence quoting the line(s). Default toward REFUTED if you cannot substantiate it. Structured output only.",
        {
          phase: "Verify",
          label: `verify:${location.file.split("/").pop() ?? location.file}`,
          tools: TOOLS,
          thinkingLevel: "low",
          schema: AdvisoryVerdictSchema,
        },
      );
      if (!judged) return null;
      recordVerdictProgress(progress, candidate, judged);
      return { ...candidate, verdict: judged.verdict, evidence: judged.evidence, kind: angle.kind };
    }),
  );

  const verified = verdicts.filter((value): value is Verified => value !== null);
  const surviving = verified.filter((finding) => finding.verdict !== "REFUTED");
  const stats = makeStats(verified.length, surviving.length);
  progress({ type: "counter", key: "verified", label: "verified", value: verified.length });
  progress({ type: "counter", key: "kept", label: "kept", value: surviving.length });
  progress({ type: "summary", key: "verified", value: verified.length });
  progress({ type: "summary", key: "kept", value: surviving.length });
  log(`${verified.length} verified → ${surviving.length} kept`);

  if (surviving.length === 0) {
    return { summary: "No findings survived verification.", findings: [], nextSteps: ["No code-review action is recommended from this workflow run."], stats };
  }

  // ─── Synthesize: rank, merge, report ───
  phase("Synthesize");
  const rank = (finding: Verified): number => (finding.kind === "cleanup" ? 2 : 0) + (finding.verdict === "PLAUSIBLE" ? 1 : 0);
  const ranked = [...surviving].sort((a, b) => rank(a) - rank(b));
  const block = ranked
    .map(
      (finding, index) =>
        `### [${index}] ${formatLocation(finding)} (${finding.verdict}${finding.kind === "cleanup" ? ", cleanup" : ""})\n` +
        `Category: ${finding.kind}\nConfidence: ${verdictConfidence(finding.verdict)}\n` +
        `${finding.summary}\nImpact: ${finding.impact}\nEvidence: ${formatEvidence(finding.evidence)}`,
    )
    .join("\n\n");

  const report = await agent(
    `## Synthesis: final code-review report\n\n${ranked.length} findings survived independent verification.\n\n${block}\n\n` +
      "Merge findings with the same root cause, rank most-severe first (correctness bugs above cleanups), and produce the final advisory report. " +
      "Return summary, findings, and nextSteps. For each finding: category must be bug or cleanup; severity is impact level (low/medium/high), not category; " +
      "confidence must be high for CONFIRMED and medium for PLAUSIBLE; copy locations and evidence arrays from the verified finding; impact is the concrete failure or maintenance scenario; recommendation is an advisory fix direction, not an edit. Structured output only.",
    { phase: "Synthesize", label: "synthesize", thinkingLevel: "medium", schema: AdvisoryReportSchema },
  );

  if (!report) return { summary: "Synthesis produced no output.", findings: [], nextSteps: ["Re-run the workflow or inspect verifier evidence manually."], stats };

  const findings = backfillAdvisoryFindings(report.findings, ranked, {
    impact: "Impact not restated by synthesis.",
  });
  return { ...report, findings, stats };
}

