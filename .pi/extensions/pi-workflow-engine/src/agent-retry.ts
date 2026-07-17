import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { abortReason, throwIfAborted } from "./cancellation.ts";

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

export function providerErrorFromMessages(messages: readonly unknown[]): WorkflowProviderError | undefined {
  const message = messages.findLast(isAssistantMessage);
  if (!message || message.stopReason !== "error") return undefined;
  const errorMessage = typeof message.errorMessage === "string" && message.errorMessage.length > 0
    ? message.errorMessage
    : "Provider session ended with an unspecified error.";
  const retryable = isRetryableAssistantError(message as AssistantMessage);
  const provider = stringDetail(message.provider);
  const model = stringDetail(message.model);
  const api = stringDetail(message.api);
  return new WorkflowProviderError(errorMessage, {
    stopReason: "error",
    retryable,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(api ? { api } : {}),
  });
}

function isAssistantMessage(value: unknown): value is {
  readonly role: "assistant";
  readonly stopReason?: unknown;
  readonly errorMessage?: unknown;
  readonly provider?: unknown;
  readonly model?: unknown;
  readonly api?: unknown;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant"
  );
}

function stringDetail(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
