import type {
  LoadedWorkflow,
  WorkflowMeta,
  WorkflowModule,
  WorkflowSourceIdentity,
} from "./types.ts";
import type { WorktreeBaseline } from "./worktree.ts";

type WorkflowMetaCandidate = {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly phases?: unknown;
};

type WorkflowModuleCandidate = {
  readonly meta?: unknown;
  readonly default?: unknown;
};

/** Validate and normalize workflow metadata without executing workflow code. */
export function parseWorkflowMeta(value: unknown): { meta: WorkflowMeta } | { reason: string } {
  if (!isRecord(value)) return { reason: "meta export must be an object" };
  return parseWorkflowMetaObject(value);
}

export function parseWorkflowModule(value: unknown): { module: WorkflowModule } | { reason: string } {
  if (!isRecord(value)) return { reason: "module export is not an object" };
  const candidate = value as WorkflowModuleCandidate;
  const meta = candidate.meta;
  if (!isRecord(meta)) return { reason: "missing meta export" };

  const parsedMeta = parseWorkflowMetaObject(meta);
  if ("reason" in parsedMeta) return parsedMeta;
  if (!isWorkflowRun(candidate.default)) return { reason: "default export must be a function" };

  return { module: { meta: parsedMeta.meta, default: candidate.default } };
}

/** Attach engine-owned source provenance after an authored module has been validated. */
export function loadWorkflow(
  module: WorkflowModule,
  source: WorkflowSourceIdentity,
  isolatedWorktreeBaseline?: WorktreeBaseline,
): LoadedWorkflow {
  return isolatedWorktreeBaseline === undefined
    ? { ...module, source }
    : { ...module, source, isolatedWorktreeBaseline };
}

function parseWorkflowMetaObject(meta: WorkflowMetaCandidate): { meta: WorkflowMeta } | { reason: string } {
  if (typeof meta.name !== "string") return { reason: "meta.name must be a string" };

  const description = meta.description;
  if (description !== undefined && typeof description !== "string") return { reason: "meta.description must be a string when provided" };

  const phases = meta.phases;
  if (phases !== undefined && !isWorkflowPhases(phases)) return { reason: "meta.phases must be an array of { title: string }" };

  const workflowMeta: WorkflowMeta = { name: meta.name, description: description ?? "" };
  if (phases !== undefined) workflowMeta.phases = phases;
  return { meta: workflowMeta };
}

function isWorkflowRun(value: unknown): value is WorkflowModule["default"] {
  return typeof value === "function";
}

function isWorkflowPhases(value: unknown): value is Array<{ title: string }> {
  return Array.isArray(value) && value.every((phase) => isRecord(phase) && typeof phase.title === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
