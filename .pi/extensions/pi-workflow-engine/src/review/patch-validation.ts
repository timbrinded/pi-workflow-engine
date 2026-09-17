import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import { throwIfAborted } from "../cancellation.ts";
import { runBoundedProcess, type BoundedProcessResult } from "../process-runner.ts";
import { WorktreeRegistry, type WorktreeBaseline } from "../worktree.ts";
import { unknownErrorMessage } from "../unknown-error.ts";
import { fingerprintReviewWorktreeBaseline } from "./review-snapshot.ts";

export const PatchEvaluationSchema = Type.Object({
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("blocked")]),
  reason: Type.String(),
  checks: Type.Array(Type.Object({
    file: Type.String({ description: "Executable for a focused validation command, not a shell command string." }),
    args: Type.Array(Type.String()),
    required: Type.Boolean(),
    regression: Type.Optional(Type.Object({
      baselinePatch: Type.String({ description: "Test-only patch to apply to the original baseline to reproduce the bug; exclude the repair." }),
      expectedFailure: Type.String({ description: "Specific failure text proving the intended defect, not a missing dependency or setup error." }),
    })),
  }), { maxItems: 6 }),
});
export type PatchEvaluation = Static<typeof PatchEvaluationSchema>;
export type PatchCandidateStatus = "verified" | "rejected" | "blocked" | "no-patch";
export interface PatchValidation {
  status: PatchCandidateStatus;
  baselineFingerprint: string;
  baselineOid?: string;
  patchHash: string;
  checks: { file: string; args: string[]; required: boolean; stage: "candidate" | "baseline"; result: BoundedProcessResult }[];
  evaluation?: PatchEvaluation;
  reason: string;
  cleanupError?: string;
}
export function initialPatchValidation(baseline: WorktreeBaseline, baselineOid: string | undefined, patch: string): PatchValidation {
  return { status: patch.trim() ? "blocked" : "no-patch", baselineFingerprint: fingerprintReviewWorktreeBaseline(baseline), ...(baselineOid ? { baselineOid } : {}),
    patchHash: createHash("sha256").update(patch).digest("hex"), checks: [], reason: patch.trim() ? "Independent evaluation has not completed." : "The implementer produced no patch; this does not establish that no change is needed." };
}

interface PatchValidationOptions {
  cwd: string; baseline: WorktreeBaseline; expectedFingerprint: string; baselineOid: string; patch: string;
  evaluation: PatchEvaluation; signal?: AbortSignal;
}

/** Reconstruct the exact reviewed baseline and retain evidence even if cleanup fails. */
export async function validateCandidatePatch(options: PatchValidationOptions): Promise<PatchValidation> {
  const validation = initialPatchValidation(options.baseline, options.baselineOid, options.patch);
  validation.evaluation = options.evaluation;
  if (validation.baselineFingerprint !== options.expectedFingerprint) return { ...validation, status: "rejected", reason: "Stale reviewed baseline identity." };
  if (!options.patch.trim()) return validation;
  const worktrees = new WorktreeRegistry(options.cwd);
  let result = validation;
  try {
    result = await evaluateCandidateInWorktrees(worktrees, options, validation);
  } catch (error) {
    throwIfAborted(options.signal);
    result = { ...validation, status: "blocked", reason: unknownErrorMessage(error) };
  } finally {
    try {
      await worktrees.removeAll();
    } catch (error) {
      const cleanupError = unknownErrorMessage(error);
      result = {
        ...result,
        status: result.status === "verified" ? "blocked" : result.status,
        cleanupError,
        reason: `${result.reason}\nCleanup failed: ${cleanupError}`,
      };
    }
    throwIfAborted(options.signal);
  }
  return result;
}

async function evaluateCandidateInWorktrees(
  worktrees: WorktreeRegistry, options: PatchValidationOptions, validation: PatchValidation,
): Promise<PatchValidation> {
  const candidate = await worktrees.add(options.signal, options.baseline);
  if ("error" in candidate) return { ...validation, reason: candidate.error };
  if (candidate.baselineOid !== options.baselineOid) return { ...validation, status: "rejected", reason: "Candidate was produced from a different baseline." };
  const applied = await worktrees.applyPatch(candidate.path, options.patch, options.signal);
  if (!applied.ok) return { ...validation, status: "rejected", reason: applied.error ?? applied.stderr };
  const rejected = options.evaluation.outcome === "rejected" ? [options.evaluation.reason] : [];
  const blocked = options.evaluation.outcome === "blocked" ? [options.evaluation.reason] : [];
  if (!options.evaluation.checks.some((check) => check.required)) blocked.push("No required behavior check was selected.");
  for (const check of options.evaluation.checks) {
    const result = await runCheck(check, candidate.path, options.signal);
    validation.checks.push({ ...check, stage: "candidate", result });
    throwIfAborted(options.signal);
    if (!result.ok) {
      if (result.failure.kind === "exit") rejected.push(`${check.file}: ${result.failure.message}`);
      else if (check.required) blocked.push(`${check.file}: ${result.failure.message}`);
    }
    if (check.regression) {
      const original = await worktrees.add(options.signal, options.baseline);
      if ("error" in original) { blocked.push(`Baseline worktree setup failed: ${original.error}`); continue; }
      const testApplied = await worktrees.applyPatch(original.path, check.regression.baselinePatch, options.signal);
      if (!testApplied.ok) { blocked.push(`Baseline regression setup failed: ${testApplied.error ?? testApplied.stderr}`); continue; }
      const baselineResult = await runCheck(check, original.path, options.signal);
      validation.checks.push({ ...check, stage: "baseline", result: baselineResult });
      throwIfAborted(options.signal);
      if (baselineResult.ok || baselineResult.failure.kind !== "exit" || !check.regression.expectedFailure.trim() ||
        !(baselineResult.stdout + baselineResult.stderr).includes(check.regression.expectedFailure)) {
        blocked.push(`${check.file}: baseline did not reproduce the expected failure: ${check.regression.expectedFailure}`);
      }
    }
  }
  // Tests must not silently replace the candidate under evaluation.
  const after = await worktrees.capturePatch(candidate.path, candidate.baselineOid, options.signal);
  if ("error" in after) blocked.push(`Candidate capture failed: ${after.error}`);
  else if (after.patch !== options.patch) blocked.push("Validation checks changed the candidate patch.");
  if (rejected.length > 0) return { ...validation, status: "rejected", reason: [...rejected, ...blocked].join("\n") };
  if (blocked.length > 0) return { ...validation, status: "blocked", reason: blocked.join("\n") };
  return { ...validation, status: "verified", reason: "Independent evaluation and all required checks passed." };
}

function runCheck(check: PatchEvaluation["checks"][number], cwd: string, signal?: AbortSignal): Promise<BoundedProcessResult> {
  return runBoundedProcess({ file: check.file, args: check.args, cwd, signal, timeoutMs: 120_000, maxBufferBytes: 1 << 20,
    abortError: "Validation aborted", timeoutError: "Validation timed out", maxBufferError: "Validation output exceeded its limit",
    exitError: (stderr, code) => stderr.trim() || `Validation exited with ${code}` });
}
