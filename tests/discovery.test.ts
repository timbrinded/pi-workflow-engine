import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverWorkflows } from "../.pi/extensions/pi-workflow-engine/src/discovery.ts";

const extensionDir = fileURLToPath(new URL("../.pi/extensions/pi-workflow-engine/", import.meta.url));

test("workflow UI modules load without LLM calls", async () => {
  await Promise.all([
    import("../.pi/extensions/pi-workflow-engine/src/ui/workflow-format.ts"),
    import("../.pi/extensions/pi-workflow-engine/src/ui/workflow-inspector.ts"),
    import("../.pi/extensions/pi-workflow-engine/src/ui/workflow-result-renderer.ts"),
    import("../.pi/extensions/pi-workflow-engine/src/ui/workflow-widget.ts"),
  ]);
});

test("built-in workflows are discovered", async () => {
  const workflows = await discoverWorkflows(extensionDir);
  const expectedBuiltins = ["code-review", "refactor-scout", "diagnose", "perf-review"];

  for (const name of expectedBuiltins) {
    assert.ok(workflows.has(name), `expected built-in workflow ${name} to be discovered`);
  }
});

test("discoverWorkflows returns defensive cached maps", async () => {
  const first = await discoverWorkflows(extensionDir, { refresh: true });
  const second = await discoverWorkflows(extensionDir);

  assert.notEqual(first, second);
  assert.deepEqual([...first.keys()].sort(), [...second.keys()].sort());
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

    const workflows = await discoverWorkflows(tempRepo, { refresh: true });
    const descriptionless = workflows.get("descriptionless");
    assert.ok(descriptionless, "expected dynamic workflow without meta.description to load");
    assert.equal(descriptionless.meta.description, "");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("refresh discovers newly added dynamic workflows", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-refresh-"));

  try {
    const workflowDir = join(tempRepo, "workflows");
    await mkdir(workflowDir);

    const before = await discoverWorkflows(tempRepo, { refresh: true });
    assert.equal(before.has("late-workflow"), false);

    await writeFile(
      join(workflowDir, "late-workflow.ts"),
      'export const meta = { name: "late-workflow", description: "late" };\nexport default async function run() { return "ok"; }\n',
    );

    const cached = await discoverWorkflows(tempRepo);
    assert.equal(cached.has("late-workflow"), false);

    const refreshed = await discoverWorkflows(tempRepo, { refresh: true });
    assert.equal(refreshed.has("late-workflow"), true);
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("dynamic discovery skips bundled workflow basenames in repo workflow dir", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-skip-"));

  try {
    const workflowDir = join(tempRepo, "workflows");
    await mkdir(workflowDir);
    await writeFile(join(workflowDir, "code-review.ts"), 'throw new Error("repo bundled code-review should not import");\n');

    const workflows = await discoverWorkflows(tempRepo, { refresh: true });
    assert.equal(workflows.get("code-review")?.meta.name, "code-review");
  } finally {
    await rm(tempRepo, { recursive: true, force: true });
  }
});

test("user drop-in workflows still load from an injected test directory", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-user-"));
  const tempUserRoot = await mkdtemp(join(tmpdir(), "workflow-engine-user-workflows-"));
  const userWorkflowDir = join(tempUserRoot, "workflows");
  const name = `user-dropin-${Date.now()}`;

  try {
    await mkdir(userWorkflowDir, { recursive: true });
    await writeFile(
      join(userWorkflowDir, `${name}.ts`),
      `export const meta = { name: "${name}", description: "user drop-in" };\nexport default async function run() { return "ok"; }\n`,
    );

    const workflows = await discoverWorkflows(tempRepo, { refresh: true, userWorkflowDir });
    assert.equal(workflows.get(name)?.meta.description, "user drop-in");
  } finally {
    await rm(tempUserRoot, { recursive: true, force: true });
    await rm(tempRepo, { recursive: true, force: true });
  }
});
