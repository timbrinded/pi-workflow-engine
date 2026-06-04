import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowMeta, WorkflowModule } from "./types.ts";
import { BUILTIN_WORKFLOWS } from "./workflows.ts";

type WorkflowModuleCandidate = {
  meta?: { name?: unknown; description?: unknown; phases?: unknown };
  default?: unknown;
};

function parseWorkflowModule(value: unknown): { module: WorkflowModule } | { reason: string } {
  if (!value || typeof value !== "object") return { reason: "module export is not an object" };
  const candidate = value as WorkflowModuleCandidate;
  const meta = candidate.meta;
  if (!meta || typeof meta !== "object") return { reason: "missing meta export" };
  if (typeof meta.name !== "string") return { reason: "meta.name must be a string" };

  const description = meta.description;
  if (description !== undefined && typeof description !== "string") return { reason: "meta.description must be a string when provided" };

  const phases = meta.phases;
  if (phases !== undefined && !isWorkflowPhases(phases)) return { reason: "meta.phases must be an array of { title: string }" };
  if (!isWorkflowRun(candidate.default)) return { reason: "default export must be a function" };

  const workflowMeta: WorkflowMeta = { name: meta.name, description: description ?? "" };
  if (phases !== undefined) workflowMeta.phases = phases;
  return { module: { meta: workflowMeta, default: candidate.default } };
}

function isWorkflowRun(value: unknown): value is WorkflowModule["default"] {
  return typeof value === "function";
}

function isWorkflowPhases(value: unknown): value is Array<{ title: string }> {
  return Array.isArray(value) && value.every((phase) => typeof phase === "object" && phase !== null && typeof (phase as { title?: unknown }).title === "string");
}

/** Best-effort dynamic load of every `*.ts` workflow in a directory. */
async function loadDir(dir: string): Promise<WorkflowModule[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const modules: WorkflowModule[] = [];
  for (const name of entries) {
    if (!name.endsWith(".ts") || name.startsWith("_") || name.startsWith(".")) continue;
    try {
      const loaded: unknown = await import(pathToFileURL(join(dir, name)).href);
      const parsed = parseWorkflowModule(loaded);
      if ("module" in parsed) modules.push(parsed.module);
      else console.error(`[workflow-engine] skipped ${name}: ${parsed.reason}`);
    } catch (error) {
      // Drop-in loading depends on the runtime resolving TS + the bundled typebox.
      // Failures here are non-fatal: the static registry still works.
      console.error(`[workflow-engine] skipped ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return modules;
}

/**
 * All available workflows by name. Static registry wins on name collisions, so the
 * bundled example is always the verified one even if a same-named file is dropped in.
 */
export async function discoverWorkflows(repoDir: string): Promise<Map<string, WorkflowModule>> {
  const byName = new Map<string, WorkflowModule>();
  for (const mod of BUILTIN_WORKFLOWS) byName.set(mod.meta.name, mod);

  const dynamic = [
    ...(await loadDir(join(repoDir, "workflows"))),
    ...(await loadDir(join(homedir(), ".pi", "agent", "workflows"))),
  ];
  for (const mod of dynamic) {
    if (!byName.has(mod.meta.name)) byName.set(mod.meta.name, mod);
  }
  return byName;
}
