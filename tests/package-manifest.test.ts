import { readdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { DefaultResourceLoader, loadSkillsFromDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../.pi/extensions/pi-workflow-engine/src/guards.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const extensionDir = ".pi/extensions/pi-workflow-engine";
const extensionEntry = `${extensionDir}/index.ts`;
const skillPath = "skills/workflow-code-review-actions/SKILL.md";
const bundledRuntimePeers = [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const;

async function readPackageJson(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
  assert.ok(isRecord(parsed), "package.json must be an object");
  return parsed;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} must be an array`);
  assert.ok(value.every((item) => typeof item === "string"), `${key} must contain only strings`);
  return value;
}

test("package metadata declares the pi gallery keyword and skills directory", async () => {
  const pkg = await readPackageJson();
  assert.ok(stringArrayField(pkg, "keywords").includes("pi-package"), "keywords must include pi-package for the pi.dev gallery");

  const pi = pkg.pi;
  assert.ok(isRecord(pi), "package.json must contain a pi manifest object");
  assert.deepEqual(stringArrayField(pi, "skills"), ["skills"]);
});

test("package manifest leaves bundled runtime packages host-provided", async () => {
  const pkg = await readPackageJson();
  assert.ok(isRecord(pkg.peerDependencies), "package.json must contain peerDependencies");

  assert.deepEqual(Object.keys(pkg.peerDependencies).sort(), [...bundledRuntimePeers].sort());
  for (const packageName of bundledRuntimePeers) {
    assert.equal(pkg.peerDependencies[packageName], "*", `${packageName} must use the host-provided version`);
  }
});

test("package skills parse cleanly with pi's strict skill loader", async () => {
  const result = loadSkillsFromDir({ dir: join(repoDir, "skills"), source: "path" });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.name, "workflow-code-review-actions");

  const skill = await readFile(join(repoDir, skillPath), "utf8");
  assert.match(skill, /selected code-review findings/);
  assert.match(skill, /GitHub PR inline comments/);
  assert.match(skill, /gh/);
  assert.match(skill, /GitHub MCP\/tools/);
});

test("pi DefaultResourceLoader loads the package directory as one workflow extension", async () => {
  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: repoDir,
    agentDir: join(repoDir, ".pi-test-agent"),
    settingsManager,
    additionalExtensionPaths: [repoDir],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });

  await loader.reload();
  const result = loader.getExtensions();

  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);

  const [extension] = result.extensions;
  assert.ok(extension, "expected one loaded extension");
  assert.ok(extension.path.endsWith(extensionEntry));
  assert.ok(extension.commands.has("workflow"), "extension must register /workflow");
  assert.ok(extension.commands.has("workflow:inspector"), "extension must register /workflow:inspector");
  assert.ok(extension.commands.has("workflow:dynamax"), "extension must register /workflow:dynamax");
  assert.equal(extension.commands.has("workflow-inspector"), false, "extension must not register ungrouped /workflow-inspector");
  assert.equal(extension.commands.has("dynamax"), false, "extension must not register ungrouped /dynamax");
  assert.ok(extension.tools.has("workflow"), "extension must register workflow tool");
});

test("npm package contains the extension tree, manifest resources, and linked docs", async () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const parsed: unknown = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(parsed), "npm pack output must be an array");
  const first = parsed[0];
  assert.ok(isRecord(first), "npm pack output must describe the package");
  const files = first.files;
  assert.ok(Array.isArray(files), "npm pack output must include files");
  const paths = new Set(files.map((file) => (isRecord(file) ? file.path : undefined)).filter((path): path is string => typeof path === "string"));

  const pi = (await readPackageJson()).pi;
  assert.ok(isRecord(pi), "package.json must contain a pi manifest object");
  const extensionFiles = (await readdir(join(repoDir, extensionDir), { recursive: true }))
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `${extensionDir}/${path}`);
  // README.md links USAGE.md and renders assets/preview.png on the npm page.
  const required = [...stringArrayField(pi, "extensions"), ...extensionFiles, skillPath, "README.md", "USAGE.md", "LICENSE", "assets/preview.png"];
  assert.deepEqual(required.filter((path) => !paths.has(path)), []);
});
