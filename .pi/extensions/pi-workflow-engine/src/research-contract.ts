import { Type, type Static } from "typebox";

export const MAX_RESEARCH_LANES = 4;
export const MAX_LANE_EVIDENCE = 6;
export const MAX_VERIFICATION_CLAIMS = 12;

export const ResearchSourceSchema = Type.Object({
  title: Type.String({ minLength: 1, description: "Human-readable title of the supporting page." }),
  url: Type.String({ minLength: 1, description: "Direct HTTP(S) URL of the supporting page, never a search-results URL." }),
  publishedAt: Type.Optional(Type.String({ description: "Publication or update date when the page states one." })),
});

export type ResearchSource = Static<typeof ResearchSourceSchema>;

export const ResearchPlanSchema = Type.Object({
  scopeConstraints: Type.Array(Type.String()),
  lanes: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1 }),
      title: Type.String({ minLength: 1 }),
      objective: Type.String({ minLength: 1 }),
      queries: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 4 }),
    }),
    { minItems: 1, maxItems: MAX_RESEARCH_LANES },
  ),
});

export type ResearchPlan = Static<typeof ResearchPlanSchema>;
export type ResearchLane = ResearchPlan["lanes"][number];

export const ResearchEvidenceSchema = Type.Object({
  claim: Type.String({ minLength: 1 }),
  importance: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  stance: Type.Union([Type.Literal("supports"), Type.Literal("conflicts")]),
  evidence: Type.String({ minLength: 1, description: "A short supporting passage or precise paraphrase from the page." }),
  source: ResearchSourceSchema,
});

export type ResearchEvidence = Static<typeof ResearchEvidenceSchema>;

export const ResearchLaneResultSchema = Type.Object({
  laneId: Type.String({ minLength: 1 }),
  evidence: Type.Array(ResearchEvidenceSchema, { maxItems: MAX_LANE_EVIDENCE }),
  gaps: Type.Array(Type.String()),
});

export type ResearchLaneResult = Static<typeof ResearchLaneResultSchema>;

export interface ResearchClaimCandidate {
  readonly claim: string;
  readonly importance: ResearchEvidence["importance"];
  readonly evidence: readonly ResearchEvidence[];
}

export const ResearchVerificationSchema = Type.Object({
  claim: Type.String({ minLength: 1 }),
  verdict: Type.Union([
    Type.Literal("SUPPORTED"),
    Type.Literal("CONFLICTED"),
    Type.Literal("UNCERTAIN"),
    Type.Literal("INFERENCE"),
    Type.Literal("REJECTED"),
  ]),
  explanation: Type.String({ minLength: 1 }),
  sources: Type.Array(ResearchSourceSchema, { maxItems: 8 }),
});

export type ResearchVerification = Static<typeof ResearchVerificationSchema>;

export const ResearchReportEntrySchema = Type.Object({
  claim: Type.String({ minLength: 1 }),
  explanation: Type.String({ minLength: 1 }),
  citations: Type.Array(ResearchSourceSchema, { maxItems: 8 }),
});

export type ResearchReportEntry = Static<typeof ResearchReportEntrySchema>;

export const ResearchReportSchema = Type.Object({
  answer: Type.String(),
  supportedClaims: Type.Array(ResearchReportEntrySchema),
  conflictingEvidence: Type.Array(ResearchReportEntrySchema),
  uncertainties: Type.Array(ResearchReportEntrySchema),
  inferences: Type.Array(ResearchReportEntrySchema),
  sources: Type.Array(ResearchSourceSchema),
  limitations: Type.Array(Type.String()),
  nextSteps: Type.Array(Type.String()),
});

export type ResearchReport = Static<typeof ResearchReportSchema>;
