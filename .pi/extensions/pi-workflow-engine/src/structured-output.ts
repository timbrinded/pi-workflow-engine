export const MAX_SCHEMA_REPAIR_ATTEMPTS = 2;
export const STRUCTURED_OUTPUT_ERROR_CODE = "WORKFLOW_STRUCTURED_OUTPUT_NONCOMPLIANCE";

export interface StructuredOutputErrorDetails {
  readonly agentLabel: string;
  readonly promptAttempts: number;
  readonly repairAttempts: number;
}

/** Recoverable failure raised when a schema agent never calls `final_answer`. */
export class WorkflowStructuredOutputError extends Error {
  readonly name = "WorkflowStructuredOutputError";
  readonly code = STRUCTURED_OUTPUT_ERROR_CODE;
  readonly details: StructuredOutputErrorDetails;

  constructor(agentLabel: string, repairAttempts: number) {
    const promptAttempts = repairAttempts + 1;
    super(
      `Schema agent "${agentLabel}" did not call final_answer after ${promptAttempts} prompt attempts (${repairAttempts} repairs).`,
    );
    this.details = { agentLabel, promptAttempts, repairAttempts };
  }

  toJSON(): {
    readonly name: string;
    readonly message: string;
    readonly code: string;
    readonly details: StructuredOutputErrorDetails;
  } {
    return { name: this.name, message: this.message, code: this.code, details: this.details };
  }
}
