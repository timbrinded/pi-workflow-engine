import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

const indexUrl = new URL("../.pi/extensions/pi-workflow-engine/index.ts", import.meta.url).href;

test("extension index does not load discovery or engine modules at startup", () => {
  // A child process gets a fresh module registry; bun test shares one across test files.
  const code = `await import(${JSON.stringify(indexUrl)});
const loaded = Object.keys(require.cache);
const has = (suffix) => loaded.some((path) => path.endsWith(suffix));
console.log(JSON.stringify({ index: has("pi-workflow-engine/index.ts"), lazy: ["src/discovery.ts", "src/engine.ts"].filter(has) }));`;
  const result = spawnSync(process.execPath, ["--eval", code], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);

  const loaded: unknown = JSON.parse(result.stdout.trim());
  assert.deepEqual(loaded, { index: true, lazy: [] });
});
