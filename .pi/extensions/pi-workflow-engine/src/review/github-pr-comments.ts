import { throwIfAborted } from "../cancellation.ts";
import { isCommentableIssue, type ReviewContext, type ReviewIssue } from "./review-issues.ts";

export interface ExecResultLike {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code: number;
  readonly killed?: boolean;
}

export type ExecLike = (
  command: string,
  args: string[],
  options?: { readonly cwd?: string; readonly timeout?: number; readonly signal?: AbortSignal },
) => Promise<ExecResultLike>;

export interface GitHubPrContext {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
  readonly headSha: string;
  readonly url?: string;
}

export type ResolveGitHubPrContextResult = { readonly ok: true; readonly context: GitHubPrContext } | { readonly ok: false; readonly reason: string };

export type InlineCommentStatus =
  | { readonly issueId: string; readonly status: "posted"; readonly url?: string }
  | { readonly issueId: string; readonly status: "skipped"; readonly reason: string }
  | { readonly issueId: string; readonly status: "failed"; readonly reason: string };

const PR_VIEW_JSON_FIELDS = "number,headRefOid,url";

export async function resolveGitHubPrContext(
  exec: ExecLike,
  cwd: string,
  reviewContext: ReviewContext | undefined,
  signal?: AbortSignal,
): Promise<ResolveGitHubPrContextResult> {
  const parsedNumber = parsePrNumber(reviewContext?.diffCommand);
  const prArgs = parsedNumber
    ? ["pr", "view", String(parsedNumber), "--json", PR_VIEW_JSON_FIELDS]
    : ["pr", "view", "--json", PR_VIEW_JSON_FIELDS];
  const prView = await runJson(exec, cwd, prArgs, signal);
  if (!prView.ok) return { ok: false, reason: prView.reason };

  const number = numberField(prView.value, "number") ?? parsedNumber;
  const headSha = stringField(prView.value, "headRefOid");
  if (number === undefined) return { ok: false, reason: "No GitHub PR number found." };
  if (!headSha) return { ok: false, reason: "GitHub PR head SHA is missing." };

  const url = stringField(prView.value, "url");
  const baseFromUrl = parsePullRequestUrl(url);
  let owner = baseFromUrl?.owner;
  let repo = baseFromUrl?.repo;
  if (!owner || !repo) {
    const repoView = await runJson(exec, cwd, ["repo", "view", "--json", "nameWithOwner"], signal);
    if (!repoView.ok) return { ok: false, reason: repoView.reason };
    const nameWithOwner = stringField(repoView.value, "nameWithOwner");
    const parsed = parseNameWithOwner(nameWithOwner);
    owner = owner ?? parsed?.owner;
    repo = repo ?? parsed?.repo;
  }
  if (!owner || !repo) return { ok: false, reason: "GitHub repository owner/name is missing." };

  return { ok: true, context: { owner, repo, number, headSha, url } };
}

export function buildInlineCommentBody(issue: ReviewIssue): string {
  const finding = issue.finding;
  const evidence = finding.evidence.length > 0 ? finding.evidence.map((entry) => `- ${entry}`).join("\n") : "- (none cited)";
  return `**${issue.id}: ${finding.summary}**

Severity: ${finding.severity} · Confidence: ${finding.confidence} · Category: ${finding.category}

Impact: ${finding.impact}

Evidence:
${evidence}

Recommendation: ${finding.recommendation}`;
}

export async function postInlineComment(
  exec: ExecLike,
  cwd: string,
  prContext: GitHubPrContext,
  issue: ReviewIssue,
  signal?: AbortSignal,
): Promise<InlineCommentStatus> {
  if (!isCommentableIssue(issue)) return { issueId: issue.id, status: "skipped", reason: "Finding has no commentable file/line." };

  const result = await runCommand(exec, cwd, [
    "api",
    `repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}/comments`,
    "-f",
    `body=${buildInlineCommentBody(issue)}`,
    "-f",
    `commit_id=${prContext.headSha}`,
    "-f",
    `path=${issue.file}`,
    "-F",
    `line=${issue.line}`,
    "-f",
    "side=RIGHT",
  ], signal);
  if (!result.ok) return { issueId: issue.id, status: "failed", reason: result.reason };
  return { issueId: issue.id, status: "posted", url: parsePostedCommentUrl(result.stdout) };
}

export async function postInlineComments(
  exec: ExecLike,
  cwd: string,
  prContext: GitHubPrContext,
  issues: readonly ReviewIssue[],
  signal?: AbortSignal,
): Promise<InlineCommentStatus[]> {
  throwIfAborted(signal);
  const existing = await loadExistingInlineCommentKeys(exec, cwd, prContext, signal);
  if (!existing.ok) {
    return issues.map((issue) => ({ issueId: issue.id, status: "failed", reason: existing.reason }));
  }

  const statuses: InlineCommentStatus[] = [];
  for (const issue of issues) {
    throwIfAborted(signal);
    const key = inlineCommentKey(issue, prContext.headSha);
    if (key && existing.keys.has(key)) {
      statuses.push({ issueId: issue.id, status: "skipped", reason: "An identical inline comment already exists on this PR head." });
      continue;
    }
    const status = await postInlineComment(exec, cwd, prContext, issue, signal);
    statuses.push(status);
    if (key && status.status === "posted") existing.keys.add(key);
  }
  return statuses;
}

function parsePrNumber(diffCommand: string | undefined): number | undefined {
  if (!diffCommand) return undefined;
  const match = /(?:^|\s)gh\s+pr\s+diff\s+(\d+)(?:\s|$)/.exec(diffCommand);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

async function loadExistingInlineCommentKeys(
  exec: ExecLike,
  cwd: string,
  prContext: GitHubPrContext,
  signal: AbortSignal | undefined,
): Promise<{ readonly ok: true; readonly keys: Set<string> } | { readonly ok: false; readonly reason: string }> {
  const endpoint = `repos/${prContext.owner}/${prContext.repo}/pulls/${prContext.number}/comments`;
  const result = await runJson(exec, cwd, ["api", endpoint, "--paginate", "--slurp"], signal);
  if (!result.ok) return { ok: false, reason: `Could not inspect existing PR comments: ${result.reason}` };
  const keys = parseExistingInlineCommentKeys(result.value);
  return keys ? { ok: true, keys } : { ok: false, reason: "Could not inspect existing PR comments: unexpected GitHub response." };
}

async function runJson(
  exec: ExecLike,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
  const result = await runCommand(exec, cwd, args, signal);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `Invalid gh JSON: ${error.message}` : "Invalid gh JSON." };
  }
}

async function runCommand(
  exec: ExecLike,
  cwd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string }> {
  throwIfAborted(signal);
  try {
    const result = await exec("gh", args, { cwd, timeout: 30_000, signal });
    throwIfAborted(signal);
    if (result.code !== 0) return { ok: false, reason: result.stderr?.trim() || `gh exited with code ${result.code}` };
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    throwIfAborted(signal);
    return { ok: false, reason: error instanceof Error ? error.message : "gh command failed." };
  }
}

function parseExistingInlineCommentKeys(value: unknown): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const comments = value.every(Array.isArray) ? value.flat() : value;
  const keys = new Set<string>();
  for (const comment of comments) {
    const body = stringField(comment, "body");
    const path = stringField(comment, "path");
    const line = numberField(comment, "line");
    const headSha = stringField(comment, "commit_id");
    if (body && path && line !== undefined && headSha) keys.add(commentKey(body, path, line, headSha));
  }
  return keys;
}

function inlineCommentKey(issue: ReviewIssue, headSha: string): string | undefined {
  return isCommentableIssue(issue) ? commentKey(buildInlineCommentBody(issue), issue.file ?? "", issue.line ?? 0, headSha) : undefined;
}

function commentKey(body: string, path: string, line: number, headSha: string): string {
  return JSON.stringify([body, path, line, headSha]);
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function parseNameWithOwner(value: string | undefined): { readonly owner: string; readonly repo: string } | undefined {
  if (!value) return undefined;
  const [owner, repo, extra] = value.split("/");
  if (!owner || !repo || extra !== undefined) return undefined;
  return { owner, repo };
}

function parsePullRequestUrl(value: string | undefined): { readonly owner: string; readonly repo: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    const [owner, repo, type, number, extra] = parsed.pathname.split("/").filter(Boolean);
    if (!owner || !repo || type !== "pull" || !number || extra !== undefined) return undefined;
    return { owner, repo };
  } catch {
    return undefined;
  }
}

function parsePostedCommentUrl(stdout: string): string | undefined {
  try {
    return stringField(JSON.parse(stdout), "html_url");
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
