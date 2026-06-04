import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { maybeWriteBenchmarkOutput, parseBenchArgs, printBenchmarkOutput, runBenchmark } from "./lib.ts";

interface ImportTarget {
  readonly name: string;
  readonly path: string;
}

const options = parseBenchArgs();
const targets: ImportTarget[] = [
  { name: "extension_index", path: "./.pi/extensions/pi-workflow-engine/index.ts" },
  { name: "discovery", path: "./.pi/extensions/pi-workflow-engine/src/discovery.ts" },
  { name: "workflows", path: "./.pi/extensions/pi-workflow-engine/src/workflows.ts" },
  { name: "engine", path: "./.pi/extensions/pi-workflow-engine/src/engine.ts" },
];

const imports = [];
for (const target of targets) {
  const timing = await runBenchmark(`startup.${target.name}`, options.iterations, () => {
    runImportProbe(target.path);
  });
  imports.push({ ...target, timing });
}

const result = {
  benchmark: "startup",
  iterations: options.iterations,
  generatedAt: new Date().toISOString(),
  imports,
};

const written = await maybeWriteBenchmarkOutput("startup", result, options.out);
printBenchmarkOutput(written ? { ...result, written } : result, options.json);

function runImportProbe(path: string): void {
  const code = `const start = performance.now(); await import(${JSON.stringify(path)}); console.log(String(performance.now() - start));`;
  const start = performance.now();
  const result = spawnSync(process.execPath, ["--eval", code], { cwd: process.cwd(), encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`import probe failed for ${path}: ${result.stderr || result.stdout}`);
  }
  // Include process startup in the measured value, while the child also verifies the import path works.
  const elapsed = performance.now() - start;
  if (!Number.isFinite(elapsed)) throw new Error(`invalid import timing for ${path}`);
}
