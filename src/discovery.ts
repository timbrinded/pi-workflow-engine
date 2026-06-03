import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkflowModule } from "./types.ts";
import { BUILTIN_WORKFLOWS } from "./workflows.ts";

function isWorkflowModule(value: unknown): value is WorkflowModule {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { meta?: { name?: unknown }; default?: unknown };
  return typeof candidate.meta?.name === "string" && typeof candidate.default === "function";
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
      if (isWorkflowModule(loaded)) modules.push(loaded);
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
