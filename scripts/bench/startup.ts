import { spawnSync } from "node:child_process";
import { parseBenchArgs, runBenchmark, writeBenchmarkOutput } from "./lib.ts";

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

await writeBenchmarkOutput("startup", result, options.out);

function runImportProbe(path: string): void {
  // runBenchmark times the whole child process, so the measurement includes process startup.
  const result = spawnSync(process.execPath, ["--eval", `await import(${JSON.stringify(path)});`], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`import probe failed for ${path}: ${result.stderr || result.stdout}`);
  }
}
