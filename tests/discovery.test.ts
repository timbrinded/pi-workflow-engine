import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { discoverWorkflows } from "../.pi/extensions/pi-workflow-engine/src/discovery.ts";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { BUILTIN_WORKFLOW_DEFINITIONS } from "../.pi/extensions/pi-workflow-engine/src/workflows.ts";

const extensionDir = fileURLToPath(new URL("../.pi/extensions/pi-workflow-engine/", import.meta.url));

test("every built-in workflow has a unique name, an existing file, and file-backed provenance", async () => {
  const workflows = await discoverWorkflows(extensionDir, { refresh: true });
  const names = BUILTIN_WORKFLOW_DEFINITIONS.map(({ module }) => module.meta.name);
  assert.equal(new Set(names).size, names.length, `duplicate built-in workflow names: ${names.join(", ")}`);

  for (const definition of BUILTIN_WORKFLOW_DEFINITIONS) {
    await access(definition.path);
    const workflow = workflows.get(definition.module.meta.name);
    assert.ok(workflow, `expected built-in workflow ${definition.module.meta.name} to be discovered`);
    if (workflow.source.kind !== "file") assert.fail("expected file-backed built-in provenance");
    assert.equal(workflow.source.path, definition.path);
    assert.equal(workflow.source.root, extensionDir);
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

test("default user workflow discovery honors Pi's configured agent directory", async () => {
  const tempRepo = await mkdtemp(join(tmpdir(), "workflow-engine-discovery-agent-dir-"));
  const tempAgentDir = await mkdtemp(join(tmpdir(), "workflow-engine-agent-dir-"));
  const workflowDir = join(tempAgentDir, "workflows");
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = tempAgentDir;
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      join(workflowDir, "configured-agent-dir.ts"),
      'export const meta = { name: "configured-agent-dir", description: "configured" };\nexport default async function run() { return "ok"; }\n',
    );

    const workflows = await discoverWorkflows(tempRepo, { refresh: true });
    assert.equal(workflows.get("configured-agent-dir")?.meta.description, "configured");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(tempAgentDir, { recursive: true, force: true });
    await rm(tempRepo, { recursive: true, force: true });
  }
});
