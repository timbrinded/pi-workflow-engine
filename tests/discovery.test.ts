import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverWorkflows } from "../src/discovery.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));

test("workflow UI modules load without LLM calls", async () => {
  await Promise.all([
    import("../src/ui/workflow-format.ts"),
    import("../src/ui/workflow-inspector.ts"),
    import("../src/ui/workflow-result-renderer.ts"),
    import("../src/ui/workflow-widget.ts"),
  ]);
});

test("built-in workflows are discovered", async () => {
  const workflows = await discoverWorkflows(repoDir);
  const expectedBuiltins = ["code-review", "ping", "refactor-scout", "diagnose", "perf-review"];

  for (const name of expectedBuiltins) {
    assert.ok(workflows.has(name), `expected built-in workflow ${name} to be discovered`);
  }
});

test("dynamic workflows default missing descriptions to an empty string", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-"));

  try {
    const workflowDir = join(tempRepo, "workflows");
    await mkdir(workflowDir);
    await writeFile(
      join(workflowDir, "descriptionless.ts"),
      'export const meta = { name: "descriptionless" };\nexport default async function run() { return "ok"; }\n',
    );

    const workflows = await discoverWorkflows(tempRepo);
    const descriptionless = workflows.get("descriptionless");
    assert.ok(descriptionless, "expected dynamic workflow without meta.description to load");
    assert.equal(descriptionless.meta.description, "");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});
