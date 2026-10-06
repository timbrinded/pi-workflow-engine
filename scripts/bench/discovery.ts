import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkflows } from "../../.pi/extensions/pi-workflow-engine/src/discovery.ts";
import { parseBenchArgs, runBenchmark, writeBenchmarkOutput } from "./lib.ts";

const options = parseBenchArgs();
const extensionDir = fileURLToPath(new URL("../../.pi/extensions/pi-workflow-engine/", import.meta.url));
const tempWorkflowCount = Math.max(0, Math.trunc(Number(options.flags.get("temp-workflows") ?? "0")));

// refresh bypasses the discovery cache so every iteration measures a real scan.
const cold = await runBenchmark("discovery.cold", options.iterations, async () => {
  await discoverWorkflows(extensionDir, { refresh: true });
});
const warm = await runBenchmark("discovery.warm", options.iterations, async () => {
  await discoverWorkflows(extensionDir);
});

let temp: unknown = undefined;
if (tempWorkflowCount > 0) {
  temp = await runTempWorkflowBenchmark(tempWorkflowCount, options.iterations);
}

const result = {
  benchmark: "discovery",
  iterations: options.iterations,
  generatedAt: new Date().toISOString(),
  extensionDir,
  cold,
  warm,
  temp,
};

await writeBenchmarkOutput("discovery", result, options.out);

async function runTempWorkflowBenchmark(count: number, iterations: number): Promise<unknown> {
  const repo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-bench-"));
  try {
    const workflowDir = join(repo, "workflows");
    await mkdir(workflowDir, { recursive: true });
    for (let i = 0; i < count; i++) {
      await writeFile(
        join(workflowDir, `bench-${i}.ts`),
        `export const meta = { name: "bench-${i}", description: "benchmark workflow ${i}" };\nexport default async function run() { return "ok"; }\n`,
      );
    }
    const timing = await runBenchmark("discovery.temp_workflows", iterations, async () => {
      await discoverWorkflows(repo, { refresh: true });
    });
    const workflows = await discoverWorkflows(repo);
    return { count, loaded: workflows.size, timing };
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}
