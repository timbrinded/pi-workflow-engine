export const MINIMUM_PI_VERSION = "0.80.10";

const MINIMUM_PI_CORE = [0, 80, 10] as const;

/** Fail during extension registration instead of failing later in a workflow. */
export function assertSupportedPiVersion(version: string): void {
  const core = parseVersionCore(version);
  if (!core || compareVersionCore(core, MINIMUM_PI_CORE) < 0) {
    throw new Error(
      `pi-workflow-engine requires pi ${MINIMUM_PI_VERSION} or newer; detected ${JSON.stringify(version)}. Update pi before loading this extension.`,
    );
  }
}

function parseVersionCore(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return undefined;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return undefined;
  return [core[0]!, core[1]!, core[2]!];
}

function compareVersionCore(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
