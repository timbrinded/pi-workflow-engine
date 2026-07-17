import type { WorkflowBackgroundOrigin } from "./types.ts";
import type { WorkflowRunRecord } from "./workflow-run-record.ts";

const MAX_BACKGROUND_TEXT = 2_048;

export type WorkflowRunDelivery =
  | { readonly state: "pending" }
  | { readonly state: "delivered"; readonly deliveredAt: number }
  | { readonly state: "unavailable"; readonly attemptedAt: number; readonly message: string };

export interface PersistedWorkflowBackground {
  readonly origin: WorkflowBackgroundOrigin;
  readonly delivery: WorkflowRunDelivery;
}

export function createPersistedWorkflowBackground(
  origin: WorkflowBackgroundOrigin | undefined,
): PersistedWorkflowBackground | undefined {
  if (!origin) return undefined;
  return {
    origin: {
      sessionId: boundedText(origin.sessionId),
      requestedAt: origin.requestedAt,
    },
    delivery: { state: "pending" },
  };
}

export function updateWorkflowRunDelivery(
  record: WorkflowRunRecord,
  delivery: WorkflowRunDelivery,
  at = Date.now(),
): WorkflowRunRecord {
  if (!record.background) throw new Error(`Workflow run ${record.runId} is not a background run.`);
  return {
    ...record,
    updatedAt: at,
    background: {
      origin: record.background.origin,
      delivery: delivery.state === "unavailable"
        ? { ...delivery, message: boundedText(delivery.message) }
        : delivery,
    },
  };
}

export function isPersistedWorkflowBackground(value: unknown): value is PersistedWorkflowBackground {
  if (!isRecord(value) || !isRecord(value.origin) || !isRecord(value.delivery)) return false;
  if (typeof value.origin.sessionId !== "string" || !isFiniteNumber(value.origin.requestedAt)) return false;
  switch (value.delivery.state) {
    case "pending":
      return true;
    case "delivered":
      return isFiniteNumber(value.delivery.deliveredAt);
    case "unavailable":
      return isFiniteNumber(value.delivery.attemptedAt) && typeof value.delivery.message === "string";
    default:
      return false;
  }
}

function boundedText(value: string): string {
  return value.length <= MAX_BACKGROUND_TEXT ? value : `${value.slice(0, MAX_BACKGROUND_TEXT - 1)}…`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
