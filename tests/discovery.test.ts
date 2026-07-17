import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverWorkflows } from "../.pi/extensions/pi-workflow-engine/src/discovery.ts";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

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
    const workflow = workflows.get(name);
    assert.ok(workflow, `expected built-in workflow ${name} to be discovered`);
    assert.equal(workflow.source.kind, "file");
    if (workflow.source.kind !== "file") assert.fail("expected file-backed built-in provenance");
    assert.match(workflow.source.fingerprint, /^[a-f0-9]{64}$/);
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
    assert.deepEqual(descriptionless.source, {
      kind: "unverifiable",
      reason: "dynamic workflow module graphs are not loaded from an immutable source snapshot",
    });
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

test("dynamic workflows stay non-replayable across refreshes", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-provenance-"));
  const workflowDir = join(tempRepo, "workflows");
  const path = join(workflowDir, "mutable.ts");
  const source = (value: string) =>
    `export const meta = { name: "mutable", description: "" };\nexport default async function run() { return "${value}"; }\n`;
  try {
    await mkdir(workflowDir);
    await writeFile(path, source("one"));
    const first = (await discoverWorkflows(tempRepo, { refresh: true })).get("mutable");
    assert.ok(first);

    await writeFile(path, source("two"));
    const cached = (await discoverWorkflows(tempRepo)).get("mutable");
    const refreshed = (await discoverWorkflows(tempRepo, { refresh: true })).get("mutable");
    assert.ok(cached && refreshed);
    assert.equal(await first.default({} as WorkflowApi), "one");
    assert.equal(await cached.default({} as WorkflowApi), "one");
    const refreshedValue = await refreshed.default({} as WorkflowApi);
    assert.ok(refreshedValue === "one" || refreshedValue === "two");
    assert.deepEqual(refreshed.source, {
      kind: "unverifiable",
      reason: "dynamic workflow module graphs are not loaded from an immutable source snapshot",
    });
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
    const workflow = workflows.get(name);
    assert.equal(workflow?.meta.description, "user drop-in");
    assert.deepEqual(workflow?.source, {
      kind: "unverifiable",
      reason: "dynamic user workflow dependencies do not have a declared trusted source root",
    });
  } finally {
    await rm(tempUserRoot, { recursive: true, force: true });
    await rm(tempRepo, { recursive: true, force: true });
  }
});
