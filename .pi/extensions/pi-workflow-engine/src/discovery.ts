import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LoadedWorkflow, WorkflowSourceIdentity } from "./types.ts";
import type { PerfSink } from "./perf.ts";
import { loadWorkflow, parseWorkflowModule } from "./workflow-module.ts";
import { BUILTIN_SOURCE_ROOT, BUILTIN_WORKFLOW_DEFINITIONS, BUILTIN_WORKFLOW_FILES } from "./workflows.ts";
import { captureTreeFingerprint } from "./tree-fingerprint.ts";
import { FINGERPRINT_EXCLUDED_RELATIVE_PATHS } from "./resume-context.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface DiscoverWorkflowsOptions {
  readonly refresh?: boolean;
  readonly perf?: PerfSink;
  readonly userWorkflowDir?: string;
}

const DISCOVERY_FINGERPRINT_MAX_BYTES = 32 << 20;
const DISCOVERY_FINGERPRINT_MAX_FILES = 4096;

const discoveryCache = new Map<string, Map<string, LoadedWorkflow>>();
/** Best-effort dynamic load of every `*.ts` workflow in a directory. */
async function loadDir(
  dir: string,
  sourceIdentity: (path: string) => WorkflowSourceIdentity,
  excludeFiles: ReadonlySet<string> = new Set(),
  provenanceRoot?: string,
): Promise<LoadedWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const before = provenanceRoot ? await captureDiscoveryFingerprint(provenanceRoot) : undefined;
  const modules: Array<{ readonly path: string; readonly module: Parameters<typeof loadWorkflow>[0] }> = [];
  for (const name of entries) {
    if (excludeFiles.has(name)) continue;
    if (!name.endsWith(".ts") || name.startsWith("_") || name.startsWith(".")) continue;
    try {
      const path = join(dir, name);
      const importUrl = pathToFileURL(path);
      if (before?.kind === "verified") importUrl.searchParams.set("workflowSource", before.fingerprint);
      const loaded: unknown = await import(importUrl.href);
      const parsed = parseWorkflowModule(loaded);
      if ("module" in parsed) modules.push({ path, module: parsed.module });
      else console.error(`[workflow-engine] skipped ${name}: ${parsed.reason}`);
    } catch (error) {
      // Drop-in loading depends on the runtime resolving TS + the bundled typebox.
      // Failures here are non-fatal: the static registry still works.
      console.error(`[workflow-engine] skipped ${name}: ${unknownErrorMessage(error)}`);
    }
  }
  return modules.map(({ path, module }) => loadWorkflow(module, sourceIdentity(path)));
}

async function captureDiscoveryFingerprint(root: string) {
  return await captureTreeFingerprint({
    root,
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    maxBytes: DISCOVERY_FINGERPRINT_MAX_BYTES,
    maxFiles: DISCOVERY_FINGERPRINT_MAX_FILES,
  });
}

/**
 * All available workflows by name. Static registry wins on name collisions, so the
 * bundled example is always the verified one even if a same-named file is dropped in.
 */
export async function discoverWorkflows(repoDir: string, options: DiscoverWorkflowsOptions = {}): Promise<Map<string, LoadedWorkflow>> {
  const userWorkflowDir = options.userWorkflowDir ?? join(getAgentDir(), "workflows");
  const cacheKey = `${repoDir}\0${userWorkflowDir}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && !options.refresh) {
    options.perf?.counter("discovery.cache_hit");
    return new Map(cached);
  }

  const byName = await timed(options.perf, "discovery.total_ms", async () => {
    const next = new Map<string, LoadedWorkflow>();
    const builtinSource = await captureDiscoveryFingerprint(BUILTIN_SOURCE_ROOT);
    for (const definition of BUILTIN_WORKFLOW_DEFINITIONS) {
      const source: WorkflowSourceIdentity =
        builtinSource.kind === "verified"
          ? {
              kind: "file",
              path: definition.path,
              root: definition.root,
              fingerprint: builtinSource.fingerprint,
            }
          : {
              kind: "unverifiable",
              reason: `built-in workflow source capture failed: ${builtinSource.reason}`,
            };
      next.set(definition.module.meta.name, loadWorkflow(definition.module, source));
    }

    const repoWorkflowDir = join(repoDir, "workflows");
    const [repoDynamic, userDynamic] = await Promise.all([
      timed(options.perf, "discovery.repo_dir_ms", () =>
        loadDir(
          repoWorkflowDir,
          () => ({
            kind: "unverifiable",
            reason: "dynamic workflow module graphs are not loaded from an immutable source snapshot",
          }),
          BUILTIN_WORKFLOW_FILES,
          repoDir,
        ),
      ),
      timed(options.perf, "discovery.user_dir_ms", () =>
        loadDir(userWorkflowDir, () => ({
          kind: "unverifiable",
          reason: "dynamic user workflow dependencies do not have a declared trusted source root",
        })),
      ),
    ]);

    for (const mod of repoDynamic) {
      if (!next.has(mod.meta.name)) next.set(mod.meta.name, mod);
    }
    for (const mod of userDynamic) {
      if (!next.has(mod.meta.name)) next.set(mod.meta.name, mod);
    }
    return next;
  });

  discoveryCache.set(cacheKey, byName);
  return new Map(byName);
}

async function timed<T>(perf: PerfSink | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  return perf ? await perf.time(name, fn) : await fn();
}
