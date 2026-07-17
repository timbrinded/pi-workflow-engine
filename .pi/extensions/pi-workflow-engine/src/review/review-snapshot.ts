import { createHash } from "node:crypto";
import { throwIfAborted } from "../cancellation.ts";
import { captureDiffTarget, type DiffCaptureFailure } from "../diff-capture.ts";
import {
  reviewGitDiffBaseline,
  type GitReviewDiffTarget,
  type PullRequestReviewDiffTarget,
  type ReviewDiffTarget,
} from "../review-diff-target.ts";
import { runBoundedProcess } from "../process-runner.ts";
import { unknownErrorMessage } from "../unknown-error.ts";
import type { WorktreeBaseline } from "../worktree.ts";
import type { ReviewContext, ReviewSnapshotIdentity } from "./review-report.ts";

const REVIEW_SNAPSHOT_TIMEOUT_MS = 30_000;
const REVIEW_SNAPSHOT_MAX_BYTES = 16 << 20;
const REVIEW_COMMAND_MAX_BYTES = 1 << 20;

export interface VerifiedReviewSnapshot {
  readonly status: "verified";
  readonly identity: ReviewSnapshotIdentity;
  readonly baseline: WorktreeBaseline;
}

export interface UnavailableReviewSnapshot {
  readonly status: "unavailable";
  readonly reason: string;
}

export type ReviewSnapshotCapture = VerifiedReviewSnapshot | UnavailableReviewSnapshot;

export interface CapturedReviewMaterial {
  readonly ok: true;
  /** The already-captured diff used by the review, even when its baseline cannot be verified. */
  readonly diff: string;
  readonly snapshot: ReviewSnapshotCapture;
}

export interface ReviewMaterialCaptureFailure {
  readonly ok: false;
  readonly error: string;
  readonly failure: DiffCaptureFailure;
}

export type ReviewMaterialCaptureResult = CapturedReviewMaterial | ReviewMaterialCaptureFailure;

export class ReviewSnapshotUnavailableError extends Error {
  override readonly name = "ReviewSnapshotUnavailableError";
}

/**
 * Capture one review diff and, when possible, an atomic identity for its exact
 * reconstructable post-change state. A baseline failure never discards or
 * recaptures a diff that was already captured successfully.
 */
export async function captureReviewMaterial(
  target: ReviewDiffTarget,
  cwd: string,
  signal?: AbortSignal,
): Promise<ReviewMaterialCaptureResult> {
  let latestDiff: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = await captureReviewDiff(target, cwd, signal);
    if (!before.ok) {
      throwIfAborted(signal);
      return latestDiff === undefined
        ? { ok: false, error: before.error, failure: before.failure }
        : capturedWithoutSnapshot(latestDiff, `review diff could not be recaptured: ${before.error}`);
    }
    latestDiff = before.diff;

    let baseline: WorktreeBaseline;
    try {
      baseline = await captureReviewWorktreeBaseline(target, cwd, signal);
    } catch (error) {
      throwIfAborted(signal);
      return capturedWithoutSnapshot(before.diff, `review baseline could not be captured: ${unknownErrorMessage(error)}`);
    }

    const after = await captureReviewDiff(target, cwd, signal);
    if (!after.ok) {
      throwIfAborted(signal);
      return capturedWithoutSnapshot(before.diff, `review diff could not be recaptured: ${after.error}`);
    }
    latestDiff = after.diff;

    const beforeFingerprint = fingerprintReviewDiff(before.diff);
    const afterFingerprint = fingerprintReviewDiff(after.diff);
    if (beforeFingerprint === afterFingerprint) {
      return {
        ok: true,
        diff: after.diff,
        snapshot: {
          status: "verified",
          identity: {
            diffFingerprint: afterFingerprint,
            baselineFingerprint: fingerprintReviewWorktreeBaseline(baseline),
          },
          baseline,
        },
      };
    }
  }

  if (latestDiff === undefined) throw new Error("review snapshot retry loop completed without a captured diff");
  return capturedWithoutSnapshot(latestDiff, "review target changed while its snapshot was being captured");
}

/** Revalidate the reviewed diff and reconstruct its exact post-change snapshot. */
export async function resolveReviewWorktreeBaseline(
  context: ReviewContext | undefined,
  cwd: string,
  signal?: AbortSignal,
): Promise<WorktreeBaseline> {
  if (!context?.snapshot) {
    throw new ReviewSnapshotUnavailableError("the review was not captured with a verifiable snapshot identity.");
  }

  const material = await captureReviewMaterial(context.diffTarget, cwd, signal);
  if (!material.ok) {
    throw new ReviewSnapshotUnavailableError(`the review diff could not be captured: ${material.error}`);
  }
  if (material.snapshot.status === "unavailable") {
    throw new ReviewSnapshotUnavailableError(`the reviewed snapshot could not be verified: ${material.snapshot.reason}`);
  }
  if (material.snapshot.identity.diffFingerprint !== context.snapshot.diffFingerprint) {
    throw new ReviewSnapshotUnavailableError("the reviewed diff changed after the findings were generated.");
  }
  if (material.snapshot.identity.baselineFingerprint !== context.snapshot.baselineFingerprint) {
    throw new ReviewSnapshotUnavailableError("the reviewed snapshot changed after the findings were generated.");
  }
  return material.snapshot.baseline;
}

export function fingerprintReviewWorktreeBaseline(baseline: WorktreeBaseline): string {
  return createHash("sha256")
    .update(JSON.stringify({ ref: baseline.ref, patch: baseline.patch ?? null }))
    .digest("hex");
}

async function captureReviewDiff(
  target: ReviewDiffTarget,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly ok: true; readonly diff: string } | { readonly ok: false; readonly error: string; readonly failure: DiffCaptureFailure }> {
  const captured = await captureDiffTarget(target, {
    cwd,
    signal,
    timeoutMs: REVIEW_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes: REVIEW_SNAPSHOT_MAX_BYTES,
  });
  return captured.ok
    ? { ok: true, diff: captured.stdout }
    : { ok: false, error: captured.error, failure: captured.failure };
}

async function captureReviewWorktreeBaseline(
  target: ReviewDiffTarget,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  return target.kind === "pull-request"
    ? await resolvePullRequestBaseline(target, cwd, signal)
    : await resolveGitDiffBaseline(target, cwd, signal);
}

async function resolvePullRequestBaseline(
  target: PullRequestReviewDiffTarget,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  const number = String(target.number);
  const viewed = await runReviewCommand("gh", ["pr", "view", number, "--json", "headRefOid,headRefName,headRepository"], cwd, signal);
  const details = viewed.ok ? parsePullRequestHead(viewed.stdout) : undefined;
  if (!details) {
    throw new Error(`pull request head could not be resolved: ${viewed.error ?? (viewed.stderr.trim() || "invalid head commit")}`);
  }

  if (!(await commitExists(details.head, cwd, signal))) {
    const fetched = await runReviewCommand(
      "git",
      ["fetch", "--no-tags", "--quiet", `https://github.com/${details.repository}.git`, details.branch],
      cwd,
      signal,
    );
    if (!fetched.ok || !(await commitExists(details.head, cwd, signal))) {
      throw new Error(
        `pull request ${number} head ${details.head} is not available locally: ${fetched.error ?? (fetched.stderr.trim() || "fetch did not provide the commit")}`,
      );
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
  target: GitReviewDiffTarget,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  const baseline = reviewGitDiffBaseline(target);
  switch (baseline.kind) {
    case "range":
      return { ref: await resolveCommit(baseline.ref, cwd, signal) };
    case "index":
      return await captureMutableGitBaseline(true, cwd, signal);
    case "working-tree":
      return await captureMutableGitBaseline(false, cwd, signal);
  }
}

async function captureMutableGitBaseline(
  staged: boolean,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<WorktreeBaseline> {
  const head = await tryResolveCommit("HEAD", cwd, signal);
  if (!head) throw new Error("the reviewed repository has no committed HEAD baseline");

  const args = staged
    ? ["diff", "--no-ext-diff", "--binary", "--cached", "HEAD"]
    : ["diff", "--no-ext-diff", "--binary", "HEAD"];
  const snapshot = await runReviewCommand("git", args, cwd, signal, REVIEW_SNAPSHOT_MAX_BYTES);
  if (!snapshot.ok) {
    throw new Error(`the reviewed working state could not be captured: ${snapshot.error}`);
  }
  return { ref: head, patch: snapshot.stdout };
}

async function resolveCommit(ref: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
  const resolved = await tryResolveCommit(ref, cwd, signal);
  if (!resolved) throw new Error(`review target ${ref} is not a local commit`);
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
  maxBufferBytes = REVIEW_COMMAND_MAX_BYTES,
) {
  return await runBoundedProcess({
    file,
    args,
    cwd,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
    signal,
    timeoutMs: REVIEW_SNAPSHOT_TIMEOUT_MS,
    maxBufferBytes,
    abortError: `${file} review snapshot command aborted`,
    timeoutError: `${file} review snapshot command timed out after ${REVIEW_SNAPSHOT_TIMEOUT_MS}ms`,
    maxBufferError: `${file} review snapshot command exceeded output limit`,
    exitError: (stderr, code, processSignal) => stderr.trim() || `${file} exited with code ${code ?? `signal ${processSignal ?? "unknown"}`}`,
  });
}

function capturedWithoutSnapshot(diff: string, reason: string): CapturedReviewMaterial {
  return { ok: true, diff, snapshot: { status: "unavailable", reason } };
}

function fingerprintReviewDiff(diff: string): string {
  return createHash("sha256").update(diff).digest("hex");
}
