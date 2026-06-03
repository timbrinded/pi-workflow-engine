import { cpus } from "node:os";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parallel, pipeline, Semaphore } from "./concurrency.ts";
import { runAgent, type RunContext } from "./agent-runner.ts";
import { ProgressTracker } from "./progress.ts";
import type { AgentOptions, WorkflowApi, WorkflowModule, WorkflowRunOptions } from "./types.ts";
import { WorkflowInspector } from "./ui/workflow-inspector.ts";

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
  options: WorkflowRunOptions = {},
): Promise<unknown> {
  const progress = new ProgressTracker(ctx, mod.meta.name);
  if (options.inspect && ctx.hasUI) {
    void ctx.ui
      .custom<void>(
        (tui, theme, _keybindings, done) => new WorkflowInspector(() => progress.snapshot(), tui, theme, () => done(undefined)),
        { overlay: true, overlayOptions: { anchor: "right-center", width: "60%", maxHeight: "80%", margin: 1 } },
      )
      .catch((error: unknown) => progress.log(`inspector failed: ${error instanceof Error ? error.message : String(error)}`));
  }

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
