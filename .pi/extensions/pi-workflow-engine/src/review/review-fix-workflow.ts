import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ParallelSettledError, WorkflowParallel } from "../concurrency.ts";
import { captureDiff, parseAllowedDiffCommand, type AllowedDiffCommand } from "../diff-capture.ts";
import { runBoundedProcess } from "../process-runner.ts";
import type { AgentOptions, IsolatedAgentResult, WorkflowModule } from "../types.ts";
import type { WorktreeBaseline } from "../worktree.ts";
import { formatIssueLocation, type ReviewContext, type ReviewIssue } from "./review-issues.ts";

const REVIEW_FIX_PHASE = "Generate patch previews";
const REVIEW_FIX_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const REVIEW_FIX_SOURCE_PATH = fileURLToPath(import.meta.url);
const REVIEW_SNAPSHOT_TIMEOUT_MS = 30_000;
const REVIEW_SNAPSHOT_MAX_BYTES = 16 << 20;

export interface ReviewFixPreview {
  readonly findingId: string;
  readonly result: string;
  readonly patch: string;
  readonly changed: boolean;
}

export interface ReviewFixFailure {
  readonly findingId: string;
  readonly error: ParallelSettledError;
}

export type ReviewFixOutcome = ReviewFixPreview | ReviewFixFailure;

export interface ReviewFixWorkflowResult {
  readonly summary: string;
  readonly fixes: readonly ReviewFixOutcome[];
}

type ReviewFixAgentOptions = AgentOptions & { readonly isolation: "worktree" };

export interface ReviewFixWorkflowApi {
  readonly agent: (prompt: string, options: ReviewFixAgentOptions) => Promise<IsolatedAgentResult<string>>;
  readonly parallel: WorkflowParallel;
  readonly phase: (title: string) => void;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export type ReviewBaselineResolver = (
  context: ReviewContext | undefined,
  cwd: string,
  signal?: AbortSignal,
) => Promise<WorktreeBaseline>;

export interface ReviewMaterial {
  readonly diff: string;
  readonly diffFingerprint: string;
  readonly baseline: WorktreeBaseline;
  readonly baselineFingerprint: string;
}

/** Build an ephemeral workflow that generates one isolated patch preview per finding. */
export function createReviewFixWorkflow(issues: readonly ReviewIssue[], context: ReviewContext | undefined): WorkflowModule {
  return {
    meta: {
      name: "code-review-fix-previews",
      description: "Generate isolated patch previews for selected code-review findings.",
      phases: [{ title: REVIEW_FIX_PHASE }],
    },
    default: async (api) =>
      await runReviewFixWorkflow(
        {
          agent: async (prompt, options) => await api.agent(prompt, options),
          parallel: api.parallel,
          phase: api.phase,
          cwd: api.cwd,
          signal: api.signal,
        },
        issues,
        context,
      ),
    source: { kind: "file", path: REVIEW_FIX_SOURCE_PATH },
  };
}

export function buildFixAgentPrompt(issue: ReviewIssue, context: ReviewContext | undefined): string {
  return `Generate a patch preview for exactly one verified code-review finding in your disposable git worktree.

Selected finding JSON:
\`\`\`json
${JSON.stringify({ context, issue: toFixPromptIssue(issue) })}
\`\`\`

Instructions:
- Inspect the finding and cited evidence before editing.
- Make the smallest edit that addresses only this finding.
- Preserve unrelated user changes and avoid broad refactors.
- Run focused validation if an appropriate local check is available.
- Do not create commits or branches; the engine captures your worktree diff automatically.
- Do not post GitHub PR comments or any upstream review comments.
- Finish with a concise summary of changed files and validation results; this text is returned alongside the captured patch.`;
}

export async function runReviewFixWorkflow(
  api: ReviewFixWorkflowApi,
  issues: readonly ReviewIssue[],
  context: ReviewContext | undefined,
  resolveBaseline: ReviewBaselineResolver = resolveReviewWorktreeBaseline,
): Promise<ReviewFixWorkflowResult> {
  api.phase(REVIEW_FIX_PHASE);
  const baseline = resolveBaseline(context, api.cwd, api.signal);
  const settled = await api.parallel(
    issues.map((issue) => async (): Promise<ReviewFixPreview> => {
      const isolated = await api.agent(buildFixAgentPrompt(issue, context), {
        isolation: "worktree",
        worktreeBaseline: await baseline,
        label: `fix:${issue.id}`,
        phase: REVIEW_FIX_PHASE,
        thinkingLevel: "medium",
        cacheKey: `review-fix:${issue.id}`,
        tools: [...REVIEW_FIX_TOOLS],
        toolHints: ["search"],
      });
      return {
        findingId: issue.id,
        result: isolated.result,
        patch: isolated.patch,
        changed: isolated.changed,
      };
    }),
    { settled: true },
  );

  const fixes = settled.map((entry, index): ReviewFixOutcome =>
    entry.ok ? entry.value : { findingId: issues[index]!.id, error: entry.error },
  );
  const successful = fixes.filter(isReviewFixPreview);
  const changed = successful.filter((fix) => fix.changed).length;
  const failed = fixes.length - successful.length;

  return {
    summary: `Generated ${changed} patch preview(s); ${successful.length - changed} finding(s) needed no changes; ${failed} attempt(s) failed.`,
    fixes,
  };
}

/** Revalidate the reviewed diff and reconstruct its post-change snapshot. */
export async function resolveReviewWorktreeBaseline(
  context: ReviewContext | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorktreeBaseline> {
  if (!context?.diffFingerprint) {
    throw new Error("Patch preview unavailable because the review diff was not captured with a verifiable fingerprint.");
  }
  if (!context.baselineFingerprint) {
    throw new Error("Patch preview unavailable because the reviewed snapshot was not captured with a verifiable fingerprint.");
  }

  const material = await captureReviewMaterial(context.diffCommand, cwd, signal);
  if (material.diffFingerprint !== context.diffFingerprint) {
    throw new Error("Patch preview unavailable because the reviewed diff changed after the findings were generated.");
  }
  if (material.baselineFingerprint !== context.baselineFingerprint) {
    throw new Error("Patch preview unavailable because the reviewed snapshot changed after the findings were generated.");
  }
  return material.baseline;
}

/** Capture a stable diff and exact post-change baseline, retrying once if the target moves. */
export async function captureReviewMaterial(
  diffCommand: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReviewMaterial> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await captureReviewDiff(diffCommand, cwd, signal);
    const baseline = await captureReviewWorktreeBaseline(diffCommand, cwd, signal);
    const after = await captureReviewDiff(diffCommand, cwd, signal);
    const beforeFingerprint = createHash("sha256").update(before).digest("hex");
    const afterFingerprint = createHash("sha256").update(after).digest("hex");
    if (beforeFingerprint === afterFingerprint) {
      return {
        diff: after,
        diffFingerprint: afterFingerprint,
        baseline,
        baselineFingerprint: fingerprintReviewWorktreeBaseline(baseline),
      };
    }
  }
  throw new Error("Patch preview unavailable because the review target changed while its snapshot was being captured.");
}

async function captureReviewDiff(diffCommand: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const captured = await captureDiff(diffCommand, {
    cwd,
    signal,
    timeoutMs: REVIEW_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes: REVIEW_SNAPSHOT_MAX_BYTES,
  });
  if (!captured.ok) {
    throw new Error(`Patch preview unavailable because the review diff could not be captured: ${captured.error ?? "unknown error"}`);
  }
  return captured.stdout;
}

/** Resolve the post-change tree represented by an allowed review diff command. */
export async function captureReviewWorktreeBaseline(
  diffCommand: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorktreeBaseline> {
  const command = parseAllowedDiffCommand(diffCommand);
  if ("error" in command) throw new Error(`Patch preview unavailable: ${command.error}`);
  return command.file === "gh"
    ? await resolvePullRequestBaseline(command, cwd, signal)
    : await resolveGitDiffBaseline(command, cwd, signal);
}

export function fingerprintReviewWorktreeBaseline(baseline: WorktreeBaseline): string {
  return createHash("sha256")
    .update(JSON.stringify({ ref: baseline.ref ?? null, patch: baseline.patch ?? null }))
    .digest("hex");
}

async function resolvePullRequestBaseline(
  command: AllowedDiffCommand,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  const number = command.args[2];
  if (!number || !/^\d+$/.test(number)) throw new Error("Patch preview unavailable because the pull request number is invalid.");
  const viewed = await runReviewCommand("gh", ["pr", "view", number, "--json", "headRefOid,headRefName,headRepository"], cwd, signal);
  const details = viewed.ok ? parsePullRequestHead(viewed.stdout) : undefined;
  if (!details) {
    throw new Error(`Patch preview unavailable because the pull request head could not be resolved: ${viewed.error ?? (viewed.stderr.trim() || "invalid head commit")}`);
  }

  if (!(await commitExists(details.head, cwd, signal))) {
    const fetched = await runReviewCommand(
      "git",
      ["fetch", "--no-tags", "--quiet", `https://github.com/${details.repository}.git`, details.branch],
      cwd,
      signal,
    );
    if (!fetched.ok || !(await commitExists(details.head, cwd, signal))) {
      throw new Error(`Patch preview unavailable because pull request ${number} head ${details.head} is not available locally: ${fetched.error ?? (fetched.stderr.trim() || "fetch did not provide the commit")}`);
    }
  }
  return { ref: details.head };
}

function parsePullRequestHead(value: string): { readonly head: string; readonly branch: string; readonly repository: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const candidate = parsed as {
    readonly headRefOid?: unknown;
    readonly headRefName?: unknown;
    readonly headRepository?: { readonly nameWithOwner?: unknown } | null;
  };
  if (typeof candidate.headRefOid !== "string" || !/^[0-9a-f]{40,64}$/i.test(candidate.headRefOid)) return undefined;
  if (typeof candidate.headRefName !== "string" || candidate.headRefName.length === 0 || candidate.headRefName.includes("\0")) return undefined;
  const repository = candidate.headRepository?.nameWithOwner;
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) return undefined;
  return { head: candidate.headRefOid, branch: candidate.headRefName, repository };
}

async function resolveGitDiffBaseline(
  command: AllowedDiffCommand,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  const args = command.args.slice(1);
  const staged = args.includes("--cached") || args.includes("--staged");
  const operands: string[] = [];
  for (const arg of args) {
    if (arg === "--") break;
    if (!arg.startsWith("-")) operands.push(arg);
  }

  if (!staged) {
    const range = operands.find((operand) => operand.includes(".."));
    if (range) {
      const separator = range.includes("...") ? "..." : "..";
      const target = range.slice(range.indexOf(separator) + separator.length) || "HEAD";
      return { ref: await resolveCommit(target, cwd, signal) };
    }
    if (operands.length >= 2) {
      const [left, right] = await Promise.all([
        tryResolveCommit(operands[0]!, cwd, signal),
        tryResolveCommit(operands[1]!, cwd, signal),
      ]);
      if (left && right) return { ref: right };
    }
  }

  const head = await tryResolveCommit("HEAD", cwd, signal);
  if (!head) throw new Error("Patch preview unavailable because the reviewed repository has no committed HEAD baseline.");
  const snapshotCommand = staged ? "git diff --binary --cached HEAD" : "git diff --binary HEAD";
  const snapshot = await captureDiff(snapshotCommand, {
    cwd,
    signal,
    timeoutMs: REVIEW_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes: REVIEW_SNAPSHOT_MAX_BYTES,
  });
  if (!snapshot.ok) {
    throw new Error(`Patch preview unavailable because the reviewed working state could not be captured: ${snapshot.error ?? "unknown error"}`);
  }
  return { ref: head, patch: snapshot.stdout };
}

async function resolveCommit(ref: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const resolved = await tryResolveCommit(ref, cwd, signal);
  if (!resolved) throw new Error(`Patch preview unavailable because review target ${ref} is not a local commit.`);
  return resolved;
}

async function tryResolveCommit(ref: string, cwd: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  const result = await runReviewCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`], cwd, signal);
  const commit = result.stdout.trim();
  return result.ok && /^[0-9a-f]{40,64}$/i.test(commit) ? commit : undefined;
}

async function commitExists(ref: string, cwd: string, signal: AbortSignal | undefined): Promise<boolean> {
  const result = await runReviewCommand("git", ["cat-file", "-e", `${ref}^{commit}`], cwd, signal);
  return result.ok;
}

async function runReviewCommand(
  file: "git" | "gh",
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
) {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return await runBoundedProcess({
    file,
    args,
    cwd,
    env,
    signal,
    timeoutMs: REVIEW_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes: 1 << 20,
    abortError: `${file} review snapshot command aborted`,
    timeoutError: `${file} review snapshot command timed out after ${REVIEW_SNAPSHOT_TIMEOUT_MS}ms`,
    maxBufferError: `${file} review snapshot command exceeded output limit`,
    exitError: (stderr, code, processSignal) => stderr.trim() || `${file} exited with code ${code ?? `signal ${processSignal ?? "unknown"}`}`,
  });
}

function isReviewFixPreview(outcome: ReviewFixOutcome): outcome is ReviewFixPreview {
  return "patch" in outcome;
}

function toFixPromptIssue(issue: ReviewIssue): object {
  return {
    id: issue.id,
    summary: issue.finding.summary,
    category: issue.finding.category,
    severity: issue.finding.severity,
    confidence: issue.finding.confidence,
    location: {
      file: issue.file,
      line: issue.line,
      symbol: issue.symbol,
      display: formatIssueLocation(issue),
    },
    impact: issue.finding.impact,
    evidence: issue.finding.evidence,
    recommendation: issue.finding.recommendation,
  };
}
