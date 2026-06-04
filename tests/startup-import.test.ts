import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { test } from "bun:test";

const indexPath = ".pi/extensions/pi-workflow-engine/index.ts";

test("extension index lazy-loads discovery and engine modules", async () => {
  const source = await readFile(indexPath, "utf8");

  assert.doesNotMatch(source, /import\s+\{\s*discoverWorkflows\s*\}\s+from\s+["']\.\/src\/discovery\.ts["']/);
  assert.doesNotMatch(source, /import\s+\{\s*runWorkflow\s*\}\s+from\s+["']\.\/src\/engine\.ts["']/);
  assert.match(source, /import\(["']\.\/src\/discovery\.ts["']\)/);
  assert.match(source, /import\(["']\.\/src\/engine\.ts["']\)/);
});
