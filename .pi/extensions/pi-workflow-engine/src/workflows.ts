import type { LoadedWorkflow, WorkflowModule } from "./types.ts";
import { fileURLToPath } from "node:url";
import * as codeReview from "../workflows/code-review.ts";
import * as refactorScout from "../workflows/refactor-scout.ts";
import * as diagnose from "../workflows/diagnose.ts";
import * as perfReview from "../workflows/perf-review.ts";

/**
 * Workflows statically imported by the extension. These are loaded through pi's own
 * jiti instance (because they're part of the extension's module graph), so they share
 * pi's bundled `typebox` / SDK — guaranteeing schema validation works.
 *
 * To add a guaranteed workflow: drop a `.ts` in `workflows/`, import it here, and add
 * it to this array. (Drop-in workflows discovered at runtime are also supported — see
 * discovery.ts — but the static registry is the always-correct path.)
 *
 * Do not replace these built-in imports with dynamic imports unless a dedicated test
 * proves pi's jiti virtual modules preserve the same bundled `typebox` identity for
 * dynamically imported built-ins. Startup optimizations should happen at the extension
 * entrypoint/discovery boundary first.
 */
const BUILTIN_SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));

function withSourceFile(mod: WorkflowModule, filename: string): LoadedWorkflow {
  return {
    ...mod,
    source: {
      kind: "file",
      path: fileURLToPath(new URL(`../workflows/${filename}`, import.meta.url)),
      root: BUILTIN_SOURCE_ROOT,
    },
  };
}

export const BUILTIN_WORKFLOWS: LoadedWorkflow[] = [
  withSourceFile(codeReview, "code-review.ts"),
  withSourceFile(refactorScout, "refactor-scout.ts"),
  withSourceFile(diagnose, "diagnose.ts"),
  withSourceFile(perfReview, "perf-review.ts"),
];
export const BUILTIN_WORKFLOW_FILES = new Set(["code-review.ts", "refactor-scout.ts", "diagnose.ts", "perf-review.ts"]);
export const BUILTIN_WORKFLOW_NAMES = BUILTIN_WORKFLOWS.map((mod) => mod.meta.name);
