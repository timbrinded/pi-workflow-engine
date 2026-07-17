import { unknownErrorMessage } from "./unknown-error.ts";

export type FinalizerCriticality = "required" | "best-effort";

export interface Finalizer {
  readonly name: string;
  readonly criticality: FinalizerCriticality;
  readonly run: () => void | Promise<void>;
}

export interface FinalizerFailure {
  readonly name: string;
  readonly criticality: FinalizerCriticality;
  readonly error: unknown;
}

export interface RunFinalizersOptions {
  readonly onBestEffortFailure?: (failure: FinalizerFailure) => void;
}

export class RequiredFinalizerError extends AggregateError {
  readonly failures: readonly FinalizerFailure[];

  constructor(failures: readonly FinalizerFailure[]) {
    super(
      failures.map((failure) => failure.error),
      `Required workflow finalization failed: ${failures.map((failure) => `${failure.name} (${unknownErrorMessage(failure.error)})`).join(", ")}`,
    );
    this.name = "RequiredFinalizerError";
    this.failures = failures;
  }
}

/** Execute every finalizer once, reporting advisory failures and aggregating only required failures. */
export async function runFinalizers(
  finalizers: readonly Finalizer[],
  options: RunFinalizersOptions = {},
): Promise<readonly FinalizerFailure[]> {
  const requiredFailures: FinalizerFailure[] = [];
  const bestEffortFailures: FinalizerFailure[] = [];

  for (const finalizer of finalizers) {
    try {
      await finalizer.run();
    } catch (error) {
      const failure: FinalizerFailure = {
        name: finalizer.name,
        criticality: finalizer.criticality,
        error,
      };
      if (finalizer.criticality === "required") {
        requiredFailures.push(failure);
        continue;
      }
      bestEffortFailures.push(failure);
      try {
        options.onBestEffortFailure?.(failure);
      } catch {
        // Failure observers are advisory and must not change finalization semantics.
      }
    }
  }

  if (requiredFailures.length > 0) throw new RequiredFinalizerError(requiredFailures);
  return bestEffortFailures;
}
