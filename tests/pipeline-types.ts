import { bindPipeline, pipeline } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";

const fourStageResult: Promise<Array<boolean | null>> = pipeline(
  [1, 2],
  async (value) => String(value),
  async (value) => value.length,
  async (value) => ({ value }),
  async (value) => value.value > 0,
);

const bound = bindPipeline({});
const fiveStageResult: Promise<Array<string | null>> = bound(
  [1, 2],
  async (value) => String(value),
  async (value) => value.length,
  async (value) => ({ value }),
  async (value) => value.value > 0,
  async (value) => String(value),
);

void fourStageResult;
void fiveStageResult;

// @ts-expect-error A four-stage pipeline must reject an incompatible adjacent stage.
void pipeline([1], async (value) => String(value), async (value: number) => value + 1, async (value) => value > 0, async (value) => String(value));
