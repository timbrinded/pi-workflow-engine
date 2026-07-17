import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const AdvisorySeveritySchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
  description: "Impact level of an advisory finding.",
});

export const AdvisoryConfidenceSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], {
  description: "Confidence that the finding is actionable.",
});

export const AdvisoryVerifierVerdictSchema = Type.Union([Type.Literal("CONFIRMED"), Type.Literal("PLAUSIBLE"), Type.Literal("REFUTED")], {
  description: "Verifier judgment for a candidate finding.",
});

export const AdvisoryLocationSchema = Type.Object({
  file: Type.String({ description: "Repository-relative file path." }),
  line: Type.Optional(Type.Number({ description: "Relevant 1-based line number when known." })),
  symbol: Type.Optional(Type.String({ description: "Relevant function, class, type, or other symbol when known." })),
});

export const AdvisoryCandidateSchema = Type.Object({
  summary: Type.String({ description: "One-line candidate finding or hypothesis." }),
  category: Type.String({ description: "Workflow-specific category such as bug, duplication, root-cause, or io." }),
  locations: Type.Array(AdvisoryLocationSchema, { description: "Relevant code or configuration locations." }),
  impact: Type.String({ description: "Concrete consequence if this candidate is real." }),
  recommendation: Type.Optional(Type.String({ description: "Optional first-step recommendation before synthesis." })),
});

export const AdvisoryCandidatesSchema = Type.Object({
  candidates: Type.Array(AdvisoryCandidateSchema, { description: "Candidate advisory findings or hypotheses." }),
});

export const AdvisoryVerdictSchema = Type.Object({
  verdict: AdvisoryVerifierVerdictSchema,
  evidence: Type.Array(Type.String({ description: "Quoted or cited evidence supporting the verdict." })),
  confidence: Type.Optional(AdvisoryConfidenceSchema),
});

export const AdvisoryFindingSchema = Type.Object({
  summary: Type.String({ description: "One-line final finding." }),
  category: Type.String({ description: "Workflow-specific category for grouping and display." }),
  severity: AdvisorySeveritySchema,
  confidence: AdvisoryConfidenceSchema,
  locations: Type.Array(AdvisoryLocationSchema, { description: "Relevant code or configuration locations." }),
  evidence: Type.Array(Type.String({ description: "Quoted or cited evidence." })),
  impact: Type.String({ description: "Concrete user, runtime, maintenance, or performance impact." }),
  recommendation: Type.String({ description: "Advisory next action; not an automatic edit." }),
});

export const AdvisoryReportSchema = Type.Object({
  summary: Type.String({ description: "Short overall advisory summary." }),
  findings: Type.Array(AdvisoryFindingSchema, { description: "Verified and ranked advisory findings." }),
  nextSteps: Type.Array(Type.String({ description: "Concrete follow-up commands, inspections, or decisions." })),
});

export const AdvisoryReportWithStatsSchema = Type.Object({
  ...AdvisoryReportSchema.properties,
  stats: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number()]))),
});

export type AdvisorySeverity = Static<typeof AdvisorySeveritySchema>;
export type AdvisoryConfidence = Static<typeof AdvisoryConfidenceSchema>;
export type AdvisoryVerifierVerdict = Static<typeof AdvisoryVerifierVerdictSchema>;
export type AdvisoryLocation = Static<typeof AdvisoryLocationSchema>;
export type AdvisoryCandidate = Static<typeof AdvisoryCandidateSchema>;
export type AdvisoryCandidates = Static<typeof AdvisoryCandidatesSchema>;
export type AdvisoryVerdict = Static<typeof AdvisoryVerdictSchema>;
export type AdvisoryFinding = Static<typeof AdvisoryFindingSchema>;
export type AdvisoryReport = Static<typeof AdvisoryReportSchema>;
export type AdvisoryReportWithStats = Static<typeof AdvisoryReportWithStatsSchema>;

export function isAdvisoryReport(value: unknown): value is AdvisoryReportWithStats {
  return Value.Check(AdvisoryReportWithStatsSchema, value);
}
