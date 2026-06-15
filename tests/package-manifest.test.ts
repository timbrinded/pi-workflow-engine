import { access, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "bun:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const skillPath = "skills/workflow-code-review-actions/SKILL.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArrayField(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  assert.ok(Array.isArray(value), `${key} must be an array`);
  assert.ok(value.every((item) => typeof item === "string"), `${key} must contain only strings`);
  return value;
}

test("package manifest includes code-review actions skill", async () => {
  const parsed: unknown = JSON.parse(await readFile(join(repoDir, "package.json"), "utf8"));
  assert.ok(isRecord(parsed), "package.json must be an object");
  const files = stringArrayField(parsed, "files");
  assert.ok(files.includes("skills"), "npm files must include skills");
  assert.ok(files.includes("assets/preview.png"), "npm files must include the published preview image");
  assert.ok(!files.includes("assets"), "npm files must not include every preview candidate asset");

  const pi = parsed.pi;
  assert.ok(isRecord(pi), "package.json must contain a pi manifest object");
  const skills = stringArrayField(pi, "skills");
  assert.deepEqual(skills, ["skills"]);

  await access(join(repoDir, skillPath));
  const skill = await readFile(join(repoDir, skillPath), "utf8");
  assert.match(skill, /^---\nname: workflow-code-review-actions/m);
  assert.match(skill, /selected code-review findings/);
  assert.match(skill, /GitHub PR inline comments/);
  assert.match(skill, /gh/);
  assert.match(skill, /GitHub MCP\/tools/);
});

test("package skills parse cleanly with pi's strict skill loader", () => {
  const result = loadSkillsFromDir({ dir: join(repoDir, "skills"), source: "path" });

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skills.length, 1);
  assert.equal(result.skills[0]?.name, "workflow-code-review-actions");
});

test("package dry-run includes only the published preview image", () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: repoDir, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);

  const parsed: unknown = JSON.parse(packed.stdout);
  assert.ok(Array.isArray(parsed), "npm pack output must be an array");
  const first = parsed[0];
  assert.ok(isRecord(first), "npm pack output must describe the package");
  const files = first.files;
  assert.ok(Array.isArray(files), "npm pack output must include files");
  const paths = files.map((file) => (isRecord(file) ? file.path : undefined)).filter((path): path is string => typeof path === "string");

  assert.ok(paths.includes("assets/preview.png"));
  assert.ok(!paths.some((path) => path.startsWith("assets/preview-candidate-")));
});
