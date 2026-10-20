import type {
  LoadedWorkflow,
  WorkflowMeta,
  WorkflowModule,
  WorkflowPhaseMeta,
  WorkflowSourceIdentity,
} from "./types.ts";
import type { WorktreeBaseline } from "./worktree.ts";
import { isRecord } from "./guards.ts";
import { isWorkflowModelProfileName } from "./model-profiles.ts";

const PHASES_SHAPE = 'meta.phases must be an array of { title: string, profile?: "small" | "medium" | "big" }';

/** Validate and normalize workflow metadata without executing workflow code. */
export function parseWorkflowMeta(meta: unknown): { meta: WorkflowMeta } | { reason: string } {
  if (!isRecord(meta)) return { reason: "meta export must be an object" };
  if (typeof meta.name !== "string") return { reason: "meta.name must be a string" };

  const description = meta.description;
  if (description !== undefined && typeof description !== "string") return { reason: "meta.description must be a string when provided" };

  const whenToUse = meta.whenToUse;
  if (whenToUse !== undefined && typeof whenToUse !== "string") return { reason: "meta.whenToUse must be a string when provided" };

  const phases = meta.phases === undefined ? undefined : parseWorkflowPhases(meta.phases);
  if (phases === null) return { reason: PHASES_SHAPE };

  const workflowMeta: WorkflowMeta = { name: meta.name, description: description ?? "" };
  if (whenToUse !== undefined) workflowMeta.whenToUse = whenToUse;
  if (phases !== undefined) workflowMeta.phases = phases;
  return { meta: workflowMeta };
}

export function parseWorkflowModule(value: unknown): { module: WorkflowModule } | { reason: string } {
  if (!isRecord(value)) return { reason: "module export is not an object" };
  if (value.meta === undefined) return { reason: "missing meta export" };

  const parsedMeta = parseWorkflowMeta(value.meta);
  if ("reason" in parsedMeta) return parsedMeta;
  if (!isWorkflowRun(value.default)) return { reason: "default export must be a function" };

  return { module: { meta: parsedMeta.meta, default: value.default } };
}

/** Attach engine-owned source provenance after an authored module has been validated. */
export function loadWorkflow(
  module: WorkflowModule,
  source: WorkflowSourceIdentity,
  isolatedWorktreeBaseline?: WorktreeBaseline,
): LoadedWorkflow {
  const loaded = { meta: module.meta, default: module.default, source };
  return isolatedWorktreeBaseline === undefined
    ? loaded
    : { ...loaded, isolatedWorktreeBaseline };
}

function isWorkflowRun(value: unknown): value is WorkflowModule["default"] {
  return typeof value === "function";
}

/** The declared phases keeping only known fields, or null when any entry is malformed. */
function parseWorkflowPhases(value: unknown): WorkflowPhaseMeta[] | null {
  if (!Array.isArray(value)) return null;
  const phases: WorkflowPhaseMeta[] = [];
  for (const phase of value) {
    if (!isRecord(phase) || typeof phase.title !== "string") return null;
    const { profile } = phase;
    if (profile !== undefined && (typeof profile !== "string" || !isWorkflowModelProfileName(profile))) return null;
    phases.push({ title: phase.title, ...(profile === undefined ? {} : { profile }) });
  }
  return phases;
}
