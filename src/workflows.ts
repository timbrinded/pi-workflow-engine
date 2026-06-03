import type { WorkflowModule } from "./types.ts";
import * as codeReview from "../workflows/code-review.ts";
import * as ping from "../workflows/ping.ts";
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
 */
export const BUILTIN_WORKFLOWS: WorkflowModule[] = [codeReview, ping, refactorScout, diagnose, perfReview];
