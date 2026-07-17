import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BackgroundWorkflowCoordinator, backgroundOrigin } from "./background-workflows.ts";
import { createWorkflowRunId } from "./journal.ts";
import type { ResolvedWorkflowRunOptions } from "./options.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export interface BackgroundWorkflowToolResult {
  readonly content: Array<{ readonly type: "text"; readonly text: string }>;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface BackgroundWorkflowToolStartInput {
  readonly coordinator: BackgroundWorkflowCoordinator;
  readonly ctx: ExtensionContext;
  readonly name: string;
  readonly options: ResolvedWorkflowRunOptions;
  readonly execute: (ctx: ExtensionContext, options: ResolvedWorkflowRunOptions) => Promise<void>;
}

export function backgroundUnavailableResult(mode: ExtensionContext["mode"]): BackgroundWorkflowToolResult | undefined {
  if (mode !== "print" && mode !== "json") return undefined;
  return {
    content: [{
      type: "text",
      text: `Background workflows are unavailable in ${mode} mode because pi exits after the prompt. Run synchronously or use TUI/RPC mode.`,
    }],
    details: { error: "background_unavailable", mode },
  };
}

export async function startBackgroundWorkflowTool(
  input: BackgroundWorkflowToolStartInput,
): Promise<BackgroundWorkflowToolResult> {
  const runId = createWorkflowRunId();
  const backgroundOptions: ResolvedWorkflowRunOptions = {
    ...input.options,
    inspect: false,
    resultViewer: "skip",
    runId,
    background: backgroundOrigin(input.ctx),
  };
  try {
    await input.coordinator.start({
      ctx: input.ctx,
      runId,
      run: async (signal, onStarted) => {
        await input.execute(
          { ...input.ctx, signal },
          {
            ...backgroundOptions,
            signal,
            onRunMetadata(metadata) {
              onStarted();
              return backgroundOptions.onRunMetadata?.(metadata);
            },
          },
        );
      },
    });
  } catch (error) {
    const message = unknownErrorMessage(error);
    return {
      content: [{ type: "text", text: `Background workflow did not start: ${message}` }],
      details: { error: "background_start_failed", message, runId },
    };
  }
  return {
    content: [{
      type: "text",
      text: `Background workflow "${input.name}" started.\nRun ID: ${runId}\nDurable record: .pi/.workflow-runs/${runId}.run.json`,
    }],
    details: { background: true, state: "running", name: input.name, runId },
  };
}
