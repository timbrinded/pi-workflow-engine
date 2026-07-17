import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import {
  BUILTIN_WORKFLOW_DEFINITIONS,
  BUILTIN_WORKFLOW_FILES,
  BUILTIN_WORKFLOW_NAMES,
  BUILTIN_WORKFLOWS,
} from "../.pi/extensions/pi-workflow-engine/src/workflows.ts";

const expectedNames = ["code-review", "refactor-scout", "diagnose", "perf-review"];
const expectedFiles = ["code-review.ts", "refactor-scout.ts", "diagnose.ts", "perf-review.ts"];
const extensionRoot = fileURLToPath(new URL("../.pi/extensions/pi-workflow-engine/", import.meta.url));

test("built-in registry names and files stay explicit and duplicate-free", () => {
  assert.deepEqual([...BUILTIN_WORKFLOW_NAMES].sort(), [...expectedNames].sort());
  assert.deepEqual([...BUILTIN_WORKFLOW_FILES].sort(), [...expectedFiles].sort());
  assert.deepEqual(BUILTIN_WORKFLOWS.map((mod) => mod.meta.name).sort(), [...expectedNames].sort());
  assert.equal(new Set(BUILTIN_WORKFLOW_NAMES).size, BUILTIN_WORKFLOW_NAMES.length);
  assert.equal(BUILTIN_WORKFLOW_FILES.size, expectedFiles.length);
  for (const mod of BUILTIN_WORKFLOWS) {
    assert.deepEqual(Object.keys(mod).sort(), ["default", "meta"]);
  }
  for (const definition of BUILTIN_WORKFLOW_DEFINITIONS) {
    assert.equal(definition.root, extensionRoot);
    assert.equal(definition.path, join(extensionRoot, "workflows", definition.filename));
  }
});
