import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RunContext } from "./agent-runner-types.ts";
import { assertWorkflowBudgetAvailable } from "./budget.ts";
import { throwIfAborted } from "./cancellation.ts";
import type { ClassifyOptions } from "./types.ts";

type ClassifierRegistry = Pick<ModelRegistry, "classify" | "getAvailableOfType" | "getModelOfType">;

/** No classifier model is configured, or the requested one is unknown. Recoverable inside `parallel`. */
export class WorkflowClassifierUnavailableError extends Error {
  readonly code = "WORKFLOW_CLASSIFIER_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowClassifierUnavailableError";
  }
}

/** The classifier answered with an error or no answer. Recoverable inside `parallel`. */
export class WorkflowClassifierError extends Error {
  readonly code = "WORKFLOW_CLASSIFIER_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "WorkflowClassifierError";
  }
}

/**
 * `api.classify()`: answer typed questions about JSON state with a classifier model through the host's
 * credentials, without a chat session. It shares the run's concurrency cap and budget, records usage
 * like an agent, and is not journaled, so a resumed run asks again.
 */
export async function runClassifier(
  rc: RunContext,
  context: ClassifierContext,
  opts: ClassifyOptions = {},
): Promise<Record<string, ClassifierAnswer>> {
  const registry = rc.modelRegistry;
  // Test runs inject a registry that can only resolve chat models.
  if (!("classify" in registry)) throw new WorkflowClassifierUnavailableError("This run's model registry has no classifier models.");
  return await rc.semaphore.run(async () => {
    assertWorkflowBudgetAvailable(rc.budget);
    const model = await resolveClassifierModel(registry, opts.model);
    const label = opts.label ?? `classify:${model.provider}/${model.id}`;
    const result = await registry.classify(model, context, { signal: rc.signal });
    throwIfAborted(rc.signal);
    // One classifier response is one model response: recording it like one keeps per-model usage and the budget whole.
    rc.usage.recordAgentSession({
      label,
      phase: opts.phase,
      messages: [{ role: "assistant", provider: result.provider, model: result.model, usage: result.usage }],
    });
    if (result.stopReason !== "stop") {
      throw new WorkflowClassifierError(`${label}: classifier ${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ""}`);
    }
    return result.answers;
  }, { signal: rc.signal });
}

async function resolveClassifierModel(registry: ClassifierRegistry, ref: string | undefined): Promise<ClassifierModel<ClassifierApi>> {
  if (ref === undefined) {
    const [available] = await registry.getAvailableOfType("classifier");
    if (!available) {
      throw new WorkflowClassifierUnavailableError(
        "No classifier model has working credentials. Configure one (for example TypeSafe Jev via OpenRouter) or pass { model: \"provider/id\" }.",
      );
    }
    return available;
  }
  const slash = ref.indexOf("/");
  const model = slash > 0 ? registry.getModelOfType("classifier", ref.slice(0, slash), ref.slice(slash + 1)) : undefined;
  if (!model) throw new WorkflowClassifierUnavailableError(`Classifier model "${ref}" not found; expected "provider/id".`);
  return model;
}
