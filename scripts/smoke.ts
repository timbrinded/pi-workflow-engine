// Standalone smoke test (no LLM calls): verifies the module graph loads and the
// workflow registry/discovery resolves. Run: `bun scripts/smoke.ts`
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkflows } from "../src/discovery.ts";
import "../src/ui/workflow-format.ts";
import "../src/ui/workflow-inspector.ts";
import "../src/ui/workflow-result-renderer.ts";
import "../src/ui/workflow-widget.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const workflows = await discoverWorkflows(repoDir);
const expectedBuiltins = ["code-review", "ping", "refactor-scout", "diagnose", "perf-review"];
for (const name of expectedBuiltins) {
  assert.ok(workflows.has(name), `expected built-in workflow ${name} to be discovered`);
}

const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-smoke-"));
try {
  const workflowDir = join(tempRepo, "workflows");
  await mkdir(workflowDir);
  await writeFile(
    join(workflowDir, "descriptionless.ts"),
    'export const meta = { name: "descriptionless" };\nexport default async function run() { return "ok"; }\n',
  );
  const dynamicWorkflows = await discoverWorkflows(tempRepo);
  const descriptionless = dynamicWorkflows.get("descriptionless");
  assert.ok(descriptionless, "expected dynamic workflow without meta.description to load");
  assert.equal(descriptionless.meta.description, "");
} finally {
  await rm(tempRepo, { recursive: true, force: true });
}

console.log(`Discovered ${workflows.size} workflow(s):`);
for (const mod of workflows.values()) {
  console.log(`  - ${mod.meta.name}: ${mod.meta.description}`);
  console.log(`    phases: ${(mod.meta.phases ?? []).map((p) => p.title).join(" → ") || "(none)"}`);
  console.log(`    default export is function: ${typeof mod.default === "function"}`);
}
