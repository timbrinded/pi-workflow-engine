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
): Promise<ResolveGitHubPrContextResult> {
  const parsedNumber = parsePrNumber(reviewContext?.diffCommand);
  const prArgs = parsedNumber
    ? ["pr", "view", String(parsedNumber), "--json", PR_VIEW_JSON_FIELDS]
    : ["pr", "view", "--json", PR_VIEW_JSON_FIELDS];
  const prView = await runJson(exec, cwd, prArgs);
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
    const repoView = await runJson(exec, cwd, ["repo", "view", "--json", "nameWithOwner"]);
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
  ]);
  if (!result.ok) return { issueId: issue.id, status: "failed", reason: result.reason };
  return { issueId: issue.id, status: "posted", url: parsePostedCommentUrl(result.stdout) };
}

export async function postInlineComments(
  exec: ExecLike,
  cwd: string,
  prContext: GitHubPrContext,
  issues: readonly ReviewIssue[],
): Promise<InlineCommentStatus[]> {
  const statuses: InlineCommentStatus[] = [];
  for (const issue of issues) {
    statuses.push(await postInlineComment(exec, cwd, prContext, issue));
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

async function runJson(exec: ExecLike, cwd: string, args: string[]): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string }> {
  const result = await runCommand(exec, cwd, args);
  if (!result.ok) return result;
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? `Invalid gh JSON: ${error.message}` : "Invalid gh JSON." };
  }
}

async function runCommand(exec: ExecLike, cwd: string, args: string[]): Promise<{ readonly ok: true; readonly stdout: string } | { readonly ok: false; readonly reason: string }> {
  try {
    const result = await exec("gh", args, { cwd, timeout: 30_000 });
    if (result.code !== 0) return { ok: false, reason: result.stderr?.trim() || `gh exited with code ${result.code}` };
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "gh command failed." };
  }
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
