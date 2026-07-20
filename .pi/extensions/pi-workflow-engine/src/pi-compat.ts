const MINIMUM_PI_VERSION = "0.80.10";

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
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return [major, minor, patch];
}

function compareVersionCore(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  return leftMajor - rightMajor || leftMinor - rightMinor || leftPatch - rightPatch;
}
