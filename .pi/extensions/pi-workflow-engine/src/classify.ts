import type { ClassifierAnswer, ClassifierApi, ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { RunContext } from "./agent-runner-types.ts";
import { parseAgentModelRef } from "./model-ref.ts";
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
 * credentials, without a chat session. It shares the run's concurrency cap, budget, and per-agent timeout,
 * records usage like an agent, and is not journaled, so a resumed run asks again.
 */
export async function runClassifier(
  rc: RunContext,
  context: ClassifierContext,
  opts: ClassifyOptions = {},
): Promise<Record<string, ClassifierAnswer>> {
  const registry = rc.modelRegistry;
  return await rc.semaphore.run(async () => {
    assertWorkflowBudgetAvailable(rc.budget);
    const model = await cachedClassifierModel(rc, registry, opts.model);
    const label = opts.label ?? `classify:${model.provider}/${model.id}`;
    // A stalled classifier must not hold a concurrency slot past the limit agents get.
    const timeout = AbortSignal.timeout(rc.agentTimeoutMs);
    const result = await registry.classify(model, context, { signal: rc.signal ? AbortSignal.any([rc.signal, timeout]) : timeout });
    // One classifier response is one model response: recording it like one keeps per-model usage and the budget
    // whole. Record before the abort check, since the provider charged for a call that returned as the run stopped.
    rc.usage.recordAgentSession({
      label,
      phase: opts.phase,
      messages: [{ role: "assistant", provider: result.provider, model: result.model, usage: result.usage }],
    });
    throwIfAborted(rc.signal);
    if (result.stopReason !== "stop" && timeout.aborted) {
      throw new WorkflowClassifierError(`${label}: classifier timed out after ${rc.agentTimeoutMs}ms`);
    }
    if (result.stopReason !== "stop") {
      throw new WorkflowClassifierError(`${label}: classifier ${result.stopReason}${result.errorMessage ? `: ${result.errorMessage}` : ""}`);
    }
    return result.answers;
  }, { signal: rc.signal });
}

/** One credential lookup per route and run; a route that failed to resolve keeps failing for the run. */
function cachedClassifierModel(
  rc: RunContext,
  registry: ClassifierRegistry,
  ref: string | readonly string[] | undefined,
): Promise<ClassifierModel<ClassifierApi>> {
  const key = JSON.stringify(ref ?? null);
  const cached = rc.classifierRoutes?.get(key);
  if (cached) return cached;
  const resolved = resolveClassifierModel(registry, ref);
  rc.classifierRoutes?.set(key, resolved);
  return resolved;
}

async function resolveClassifierModel(
  registry: ClassifierRegistry,
  ref: string | readonly string[] | undefined,
): Promise<ClassifierModel<ClassifierApi>> {
  if (ref !== undefined && typeof ref !== "string") {
    const available = await registry.getAvailableOfType("classifier");
    const preferred = ref.map((candidate) => parseAgentModelRef(candidate))
      .map(({ provider, id }) => available.find((model) => model.provider === provider && model.id === id))
      .find((model) => model !== undefined);
    if (!preferred) throw new WorkflowClassifierUnavailableError(`None of the classifier models ${ref.join(", ")} has working credentials.`);
    return preferred;
  }
  if (ref === undefined) {
    const [available] = await registry.getAvailableOfType("classifier");
    if (!available) {
      throw new WorkflowClassifierUnavailableError(
        "No classifier model has working credentials. Configure one (for example TypeSafe Jev via OpenRouter) or pass { model: \"provider/id\" }.",
      );
    }
    return available;
  }
  // Same ref rules as agent({ model }): malformed refs throw, bare ids mean Anthropic.
  const { provider, id } = parseAgentModelRef(ref);
  const model = registry.getModelOfType("classifier", provider, id);
  if (!model) throw new WorkflowClassifierUnavailableError(`Classifier model "${ref}" not found (resolved as ${provider}/${id}).`);
  return model;
}
