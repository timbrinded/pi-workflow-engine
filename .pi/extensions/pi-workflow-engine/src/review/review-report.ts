import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AdvisoryReportWithStatsSchema } from "../advisory-schema.ts";
import { formatReviewDiffTarget, isReviewDiffTarget, ReviewDiffTargetSchema } from "../diff-capture.ts";

/** Atomic identity of the exact diff and post-change snapshot that were reviewed. */
export const ReviewSnapshotIdentitySchema = Type.Object({
  diffFingerprint: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
  baselineFingerprint: Type.String({ pattern: "^[0-9a-fA-F]{64}$" }),
});

export const ReviewContextSchema = Type.Object({
  workflowName: Type.String(),
  target: Type.String(),
  diffTarget: ReviewDiffTargetSchema,
  files: Type.Array(Type.String()),
  summary: Type.Optional(Type.String()),
  snapshot: Type.Optional(ReviewSnapshotIdentitySchema),
});

export const ReviewReportSchema = Type.Object({
  ...AdvisoryReportWithStatsSchema.properties,
  reviewContext: Type.Optional(ReviewContextSchema),
});

export type ReviewSnapshotIdentity = Static<typeof ReviewSnapshotIdentitySchema>;
export type ReviewContext = Static<typeof ReviewContextSchema>;
export type ReviewReport = Static<typeof ReviewReportSchema>;

export function isReviewReport(value: unknown): value is ReviewReport {
  if (!Value.Check(ReviewReportSchema, value)) return false;
  return value.reviewContext === undefined || isReviewContext(value.reviewContext);
}

export function isReviewContext(value: unknown): value is ReviewContext {
  return Value.Check(ReviewContextSchema, value) && isReviewDiffTarget(value.diffTarget);
}

/** Prompt-facing context retains the canonical display command without persisting duplicate identity. */
export function serializeReviewContext(context: ReviewContext | undefined): (ReviewContext & { readonly diffCommand: string }) | undefined {
  return context ? { ...context, diffCommand: formatReviewDiffTarget(context.diffTarget) } : undefined;
}
