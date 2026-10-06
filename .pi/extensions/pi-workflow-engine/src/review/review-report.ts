import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { AdvisoryReportWithStatsSchema } from "../advisory-schema.ts";
import { formatReviewDiffTarget, isReviewDiffTarget, ReviewDiffTargetSchema } from "../review-diff-target.ts";

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

/** The schema check covers the nested context; the diff target also has to round-trip through the allowlist parser. */
export function isReviewReport(value: unknown): value is ReviewReport {
  return Value.Check(ReviewReportSchema, value) && (value.reviewContext === undefined || isReviewDiffTarget(value.reviewContext.diffTarget));
}

/** Prompt-facing context retains the canonical display command without persisting duplicate identity. */
export function serializeReviewContext(context: ReviewContext | undefined): (ReviewContext & { readonly diffCommand: string }) | undefined {
  return context ? { ...context, diffCommand: formatReviewDiffTarget(context.diffTarget) } : undefined;
}
