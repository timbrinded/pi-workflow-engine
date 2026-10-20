import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { LoadedWorkflow, WorkflowSourceIdentity } from "./types.ts";
import type { PerfSink } from "./perf.ts";
import { compileInlineWorkflow, inlineScriptFingerprint } from "./inline-workflow.ts";
import { loadWorkflow, parseWorkflowModule } from "./workflow-module.ts";
import { BUILTIN_SOURCE_ROOT, BUILTIN_WORKFLOW_DEFINITIONS, BUILTIN_WORKFLOW_FILES } from "./workflows.ts";
import { captureSourceTreeFingerprint, type FingerprintCapture } from "./tree-fingerprint.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface DiscoverWorkflowsOptions {
  readonly refresh?: boolean;
  readonly perf?: PerfSink;
  readonly userWorkflowDir?: string;
  /**
   * Project root whose `.pi/workflows/*.js` saved scripts load right after the built-ins. Callers omit
   * it for an untrusted project, which then contributes no workflows.
   */
  readonly projectDir?: string;
}

/**
 * Built-ins and `.ts` drop-ins hash source trees and import modules, so they load once per directory pair
 * until a refresh. Saved scripts are not cached: see `discoverWorkflows`.
 */
interface CachedModules {
  readonly builtins: readonly LoadedWorkflow[];
  readonly repoDynamic: readonly LoadedWorkflow[];
  readonly userDynamic: readonly LoadedWorkflow[];
}

const moduleCache = new Map<string, CachedModules>();

/** Saved scripts are re-read on every discovery, so each distinct skip is reported once, not on every lookup. */
const reportedScriptSkips = new Set<string>();

function isWorkflowFileCandidate(name: string, extension: string): boolean {
  return name.endsWith(extension) && !name.startsWith("_") && !name.startsWith(".");
}

/**
 * Load every `*.js` saved workflow in the inline script format from a directory. Unlike `.ts` drop-ins
 * they are compiled with the injected `Type`, so they share pi's typebox, and a content fingerprint is
 * their whole identity, so they replay on resume.
 */
async function loadScriptDir(dir: string): Promise<LoadedWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const workflows: LoadedWorkflow[] = [];
  for (const name of entries.filter((entry) => isWorkflowFileCandidate(entry, ".js")).sort()) {
    const path = join(dir, name);
    try {
      const source = await readFile(path, "utf8");
      const compiled = compileInlineWorkflow(source);
      workflows.push(loadWorkflow(compiled, { kind: "file", path, root: dir, fingerprint: inlineScriptFingerprint(source), selfContained: true }));
    } catch (error) {
      const note = `[workflow-engine] skipped ${name}: ${unknownErrorMessage(error)}`;
      const key = `${path}\0${note}`;
      if (!reportedScriptSkips.has(key)) {
        reportedScriptSkips.add(key);
        console.error(note);
      }
    }
  }
  return workflows;
}

/** Best-effort dynamic load of every `*.ts` workflow in a directory. */
async function loadDir(
  dir: string,
  sourceIdentity: (path: string) => WorkflowSourceIdentity,
  excludeFiles: ReadonlySet<string> = new Set(),
  captureProvenance?: () => Promise<FingerprintCapture>,
): Promise<LoadedWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const candidates = entries.filter((name) => !excludeFiles.has(name) && isWorkflowFileCandidate(name, ".ts"));
  // The shipped workflows/ dir holds only excluded built-ins; skip the tree hash when nothing will be imported.
  if (candidates.length === 0) return [];

  const before = await captureProvenance?.();
  const modules: Array<{ readonly path: string; readonly module: Parameters<typeof loadWorkflow>[0] }> = [];
  for (const name of candidates) {
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

/**
 * All available workflows by name. The first source to define a name wins: the static registry, so
 * the bundled example is always the verified one even if a same-named file is dropped in, then the
 * project's saved scripts, the extension's `.ts` drop-ins, the user's saved scripts, and the user's
 * `.ts` drop-ins.
 *
 * Saved scripts are read and compiled on every call (small files, no import), so one written or edited
 * mid-session resolves by name with its current content; built-ins and `.ts` drop-ins come from the cache
 * unless `refresh` is set.
 */
export async function discoverWorkflows(repoDir: string, options: DiscoverWorkflowsOptions = {}): Promise<Map<string, LoadedWorkflow>> {
  const userWorkflowDir = options.userWorkflowDir ?? join(getAgentDir(), "workflows");
  const projectWorkflowDir = options.projectDir === undefined ? undefined : join(options.projectDir, ".pi", "workflows");
  return await timed(options.perf, "discovery.total_ms", async () => {
    const [modules, projectScripts, userScripts] = await Promise.all([
      cachedModules(repoDir, userWorkflowDir, options),
      projectWorkflowDir === undefined
        ? []
        : timed(options.perf, "discovery.project_scripts_ms", () => loadScriptDir(projectWorkflowDir)),
      timed(options.perf, "discovery.user_scripts_ms", () => loadScriptDir(userWorkflowDir)),
    ]);
    const byName = new Map<string, LoadedWorkflow>();
    for (const mod of [...modules.builtins, ...projectScripts, ...modules.repoDynamic, ...userScripts, ...modules.userDynamic]) {
      if (!byName.has(mod.meta.name)) byName.set(mod.meta.name, mod);
    }
    return byName;
  });
}

async function cachedModules(repoDir: string, userWorkflowDir: string, options: DiscoverWorkflowsOptions): Promise<CachedModules> {
  const cacheKey = `${repoDir}\0${userWorkflowDir}`;
  const cached = moduleCache.get(cacheKey);
  if (cached && !options.refresh) {
    options.perf?.counter("discovery.cache_hit");
    return cached;
  }

  const builtinSource = await captureSourceTreeFingerprint(BUILTIN_SOURCE_ROOT);
  const builtins = BUILTIN_WORKFLOW_DEFINITIONS.map((definition) => {
    const source: WorkflowSourceIdentity =
      builtinSource.kind === "verified"
        ? {
            kind: "file",
            path: definition.path,
            root: BUILTIN_SOURCE_ROOT,
            fingerprint: builtinSource.fingerprint,
          }
        : {
            kind: "unverifiable",
            reason: `built-in workflow source capture failed: ${builtinSource.reason}`,
          };
    return loadWorkflow(definition.module, source);
  });

  const repoWorkflowDir = join(repoDir, "workflows");
  // The shipped extension dir is both the built-in root and the drop-in root; hash that tree once.
  const repoProvenance =
    resolve(repoDir) === resolve(BUILTIN_SOURCE_ROOT) ? async () => builtinSource : () => captureSourceTreeFingerprint(repoDir);
  const [repoDynamic, userDynamic] = await Promise.all([
    timed(options.perf, "discovery.repo_dir_ms", () =>
      loadDir(
        repoWorkflowDir,
        () => ({
          kind: "unverifiable",
          reason: "dynamic workflow module graphs are not loaded from an immutable source snapshot",
        }),
        BUILTIN_WORKFLOW_FILES,
        repoProvenance,
      ),
    ),
    timed(options.perf, "discovery.user_dir_ms", () =>
      loadDir(userWorkflowDir, () => ({
        kind: "unverifiable",
        reason: "dynamic user workflow dependencies do not have a declared trusted source root",
      })),
    ),
  ]);

  const modules: CachedModules = { builtins, repoDynamic, userDynamic };
  moduleCache.set(cacheKey, modules);
  return modules;
}

async function timed<T>(perf: PerfSink | undefined, name: string, fn: () => Promise<T>): Promise<T> {
  return perf ? await perf.time(name, fn) : await fn();
}
