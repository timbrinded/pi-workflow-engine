import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { abortReason, throwIfAborted } from "./cancellation.ts";
import {
  lastAssistantError,
  providerUsageLimitFromMessages,
  type WorkflowProviderUsageLimitError,
} from "./provider-usage-limit.ts";

export const AGENT_RETRY_BASE_DELAY_MS = 1_000;
export const AGENT_RETRY_MAX_DELAY_MS = 30_000;
export const WORKFLOW_PROVIDER_ERROR_CODE = "WORKFLOW_PROVIDER_ERROR";

export interface AgentRetryScheduler {
  sleep(delayMs: number, signal: AbortSignal | undefined): Promise<void>;
}

export interface ProviderErrorDetails {
  readonly stopReason: "error";
  readonly retryable: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly api?: string;
}

/** Provider failure reconstructed from pi's terminal assistant-message metadata. */
export class WorkflowProviderError extends Error {
  override readonly name = "WorkflowProviderError";
  readonly code = WORKFLOW_PROVIDER_ERROR_CODE;

  constructor(
    message: string,
    readonly details: ProviderErrorDetails,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.details.retryable;
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly code: string;
    readonly details: ProviderErrorDetails;
  } {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}

export const defaultAgentRetryScheduler: AgentRetryScheduler = {
  async sleep(delayMs, signal) {
    throwIfAborted(signal);
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        cleanup();
        reject(abortReason(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  },
};

export function agentRetryDelayMs(retryAttempt: number): number {
  return Math.min(AGENT_RETRY_MAX_DELAY_MS, AGENT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryAttempt - 1));
}

export function providerErrorFromMessages(
  messages: readonly unknown[],
  options: { readonly pauseOnUsageLimit?: boolean } = {},
): WorkflowProviderError | WorkflowProviderUsageLimitError | undefined {
  if (options.pauseOnUsageLimit) {
    const usageLimit = providerUsageLimitFromMessages(messages);
    if (usageLimit) return usageLimit;
  }
  const failure = lastAssistantError(messages);
  if (!failure) return undefined;
  const { errorMessage } = failure.message;
  return new WorkflowProviderError(
    typeof errorMessage === "string" && errorMessage.length > 0
      ? errorMessage
      : "Provider session ended with an unspecified error.",
    {
      stopReason: "error",
      retryable: isRetryableAssistantError(failure.message as AssistantMessage),
      ...failure.details,
    },
  );
}
