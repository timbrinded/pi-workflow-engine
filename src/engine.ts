import { cpus } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parallel, pipeline, Semaphore } from "./concurrency.ts";
import { runAgent, type RunContext } from "./agent-runner.ts";
import { ProgressTracker } from "./progress.ts";
import type { AgentOptions, WorkflowApi, WorkflowModule, WorkflowRunOptions } from "./types.ts";

/** Default global cap on concurrent agents per run. */
const DEFAULT_CONCURRENCY = Math.min(8, Math.max(2, cpus().length));

/**
 * Run a workflow module: build the per-run primitives (binding agent/parallel/pipeline
 * to a shared semaphore + progress tracker), invoke the workflow, return its result.
 */
export async function runWorkflow(
  ctx: ExtensionContext,
  mod: WorkflowModule,
  args: string,
  _options: WorkflowRunOptions = {},
): Promise<unknown> {
  const progress = new ProgressTracker(ctx, mod.meta.name);
  const rc: RunContext = {
    cwd: ctx.cwd,
    hostModel: ctx.model,
    modelRegistry: ctx.modelRegistry,
    semaphore: new Semaphore(DEFAULT_CONCURRENCY),
    progress,
    signal: ctx.signal,
  };

  const agent = ((prompt: string, opts?: AgentOptions) => runAgent(rc, prompt, opts)) as WorkflowApi["agent"];

  const api: WorkflowApi = {
    agent,
    parallel,
    pipeline,
    phase: (title) => progress.phase(title),
    log: (message) => progress.log(message),
    progress: (event) => progress.event(event),
    args,
    cwd: ctx.cwd,
    signal: ctx.signal,
  };

  try {
    return await mod.default(api);
  } finally {
    progress.done();
  }
}
