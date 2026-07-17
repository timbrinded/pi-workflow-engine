import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type GitDiffBaselineTarget =
  | { readonly kind: "working-tree" }
  | { readonly kind: "index" }
  | { readonly kind: "range"; readonly ref: string };

export const GitReviewDiffTargetSchema = Type.Object({
  kind: Type.Literal("git"),
  args: Type.Array(Type.String()),
});

export const PullRequestReviewDiffTargetSchema = Type.Object({
  kind: Type.Literal("pull-request"),
  number: Type.Integer({ minimum: 1 }),
});

export const ReviewDiffTargetSchema = Type.Union([GitReviewDiffTargetSchema, PullRequestReviewDiffTargetSchema]);

export type GitReviewDiffTarget = Static<typeof GitReviewDiffTargetSchema>;
export type PullRequestReviewDiffTarget = Static<typeof PullRequestReviewDiffTargetSchema>;

/** Serializable semantic identity of the diff being reviewed. */
export type ReviewDiffTarget = Static<typeof ReviewDiffTargetSchema>;

const SAFE_REF_OR_PATH = /^[A-Za-z0-9_./:@~+=,\-]+$/;
const SAFE_GH_DIFF_FLAGS = new Set(["--color=never"]);
const SAFE_GIT_DIFF_FLAGS = new Set(["--binary", "--cached", "--staged", "--no-color", "--color=never", "--no-ext-diff"]);

export function parseAllowedDiffCommand(command: string): ReviewDiffTarget | { error: string } {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return { error: "empty or incomplete diff command" };
  if (tokens[0] === "git" && tokens[1] === "diff") {
    const parsed = parseGitDiff(tokens);
    return "error" in parsed ? parsed : parsed.target;
  }
  if (tokens[0] === "gh" && tokens[1] === "pr" && tokens[2] === "diff" && /^\d+$/.test(tokens[3] ?? "")) {
    const number = Number(tokens[3]);
    if (!Number.isSafeInteger(number) || number <= 0) return { error: "pull-request number must be a positive safe integer" };
    const flags = tokens.slice(4);
    if (flags.includes("--patch")) return { error: "gh pr diff --patch is not supported because reviews require the cumulative pull-request diff" };
    const unsupported = flags.find((token) => !SAFE_GH_DIFF_FLAGS.has(token));
    if (unsupported) return { error: `unsupported gh pr diff option: ${unsupported}` };
    return { kind: "pull-request", number };
  }
  return { error: "diff command is not in the git/gh allowlist" };
}

function parseGitDiff(
  tokens: readonly string[],
): { readonly target: GitReviewDiffTarget; readonly baseline: GitDiffBaselineTarget } | { readonly error: string } {
  const args = tokens.slice(2);
  const safeArgs = ["diff", "--no-ext-diff"];
  const operands: string[] = [];
  let staged = false;
  let pathMode = false;

  for (const token of args) {
    if (!SAFE_REF_OR_PATH.test(token)) return { error: `unsupported git diff token: ${token}` };
    if (token === "--") {
      pathMode = true;
      safeArgs.push(token);
      continue;
    }
    if (!pathMode && token.startsWith("-")) {
      if (!isAllowedGitDiffFlag(token)) return { error: `unsupported git diff option: ${token}` };
      staged ||= token === "--cached" || token === "--staged";
      if (token !== "--no-ext-diff") safeArgs.push(token);
      continue;
    }
    if (!pathMode) operands.push(token);
    safeArgs.push(token);
  }

  const baseline = classifyGitDiffBaseline(staged, operands);
  return "error" in baseline ? baseline : { target: { kind: "git", args: safeArgs }, baseline };
}

function classifyGitDiffBaseline(staged: boolean, operands: readonly string[]): GitDiffBaselineTarget | { readonly error: string } {
  if (operands.length > 1) {
    return { error: "ambiguous git diff operands; use A..B or A...B for revisions, or -- before multiple paths" };
  }
  if (staged) return { kind: "index" };

  const range = operands.find((operand) => operand.includes(".."));
  if (range) {
    const separator = range.includes("...") ? "..." : "..";
    return { kind: "range", ref: range.slice(range.indexOf(separator) + separator.length) || "HEAD" };
  }

  return { kind: "working-tree" };
}

function isAllowedGitDiffFlag(token: string): boolean {
  return SAFE_GIT_DIFF_FLAGS.has(token) || /^-U\d+$/.test(token) || /^--unified=\d+$/.test(token) || /^--inter-hunk-context=\d+$/.test(token);
}

export function reviewDiffCommand(target: ReviewDiffTarget): { readonly file: "git" | "gh"; readonly args: readonly string[] } {
  return target.kind === "pull-request"
    ? { file: "gh", args: ["pr", "diff", String(target.number), "--color=never"] }
    : { file: "git", args: target.args };
}

/** Canonical display form. Never execute this string directly; use reviewDiffCommand(). */
export function formatReviewDiffTarget(target: ReviewDiffTarget): string {
  const command = reviewDiffCommand(target);
  return [command.file, ...command.args].join(" ");
}

/** Derive reconstruction semantics from the canonical git command instead of persisting duplicate state. */
export function reviewGitDiffBaseline(target: GitReviewDiffTarget): GitDiffBaselineTarget {
  const parsed = parseGitDiff(["git", ...target.args]);
  if ("error" in parsed) throw new Error(`Invalid persisted git review target: ${parsed.error}`);
  return parsed.baseline;
}

/** Validate persisted targets by round-tripping through the single command allowlist parser. */
export function isReviewDiffTarget(value: unknown): value is ReviewDiffTarget {
  if (!Value.Check(ReviewDiffTargetSchema, value)) return false;
  const parsed = parseAllowedDiffCommand(formatReviewDiffTarget(value));
  return !("error" in parsed) && sameReviewDiffTarget(parsed, value);
}

function sameReviewDiffTarget(left: ReviewDiffTarget, right: ReviewDiffTarget): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "pull-request") return right.kind === "pull-request" && left.number === right.number;
  if (right.kind !== "git" || left.args.length !== right.args.length) return false;
  return left.args.every((arg, index) => arg === right.args[index]);
}
