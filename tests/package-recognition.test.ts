import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const extensionEntry = ".pi/extensions/pi-workflow-engine/index.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

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

test("package manifest points at an existing canonical pi extension entry", async () => {
  const pkg = await readPackageJson();
  const pi = pkg.pi;
  assert.ok(isRecord(pi), "package.json must contain a pi manifest object");

  const extensions = stringArrayField(pi, "extensions");
  assert.equal(extensions[0], extensionEntry);

  for (const entry of extensions) {
    await access(join(repoDir, entry));
  }
});

test("package metadata exposes extension/gallery resources", async () => {
  const pkg = await readPackageJson();
  const keywords = stringArrayField(pkg, "keywords");
  const files = stringArrayField(pkg, "files");
  const pi = pkg.pi;
  assert.ok(isRecord(pi), "package.json must contain a pi manifest object");

  assert.ok(keywords.includes("pi-package"), "keywords must include pi-package");
  assert.ok(keywords.includes("pi-extension"), "keywords must include pi-extension");
  assert.ok(files.includes(".pi/extensions/pi-workflow-engine"), "files must include moved extension tree");
  assert.ok(files.includes(".pi/settings.json"), "files must include project pi settings");
  assert.ok(files.includes("assets/preview.png"), "files must include the published preview image");
  assert.ok(!files.includes("assets"), "files must not include unused preview candidate assets");
  assert.ok(files.includes("USAGE.md"), "files must include linked usage guide");
  assert.equal(pi.image, "https://raw.githubusercontent.com/timbrinded/pi-workflow-engine/master/assets/preview.png");
  await access(join(repoDir, "assets", "preview.png"));
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
