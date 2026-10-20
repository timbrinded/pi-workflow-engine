import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  parseWorkflowSizeCommand,
  resolveWorkflowSize,
  setWorkflowSize,
  workflowSettingsPaths,
  workflowSizeArgumentCompletions,
  workflowSizeGuidelineLine,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-settings.ts";
import { WORKFLOWS_SECTION } from "../.pi/extensions/pi-workflow-engine/src/workflow-catalog.ts";
import { captureWorkflowExtension } from "./workflow-extension-fixtures.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-settings-"));
process.once("exit", () => rmSync(TEST_ROOT, { recursive: true, force: true }));

function paths(name: string) {
  return workflowSettingsPaths(join(TEST_ROOT, name, "project"), join(TEST_ROOT, name, "agent"));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}

test("the size guideline defaults to medium and the project file overrides the user file", () => {
  const files = paths("resolve");
  assert.deepEqual(resolveWorkflowSize(files), { size: "medium", source: "default" });

  writeJson(files.user, { size: "small" });
  assert.deepEqual(resolveWorkflowSize(files), { size: "small", source: "user", configPath: files.user });

  writeJson(files.project, { size: "off" });
  assert.deepEqual(resolveWorkflowSize(files), { size: "off", source: "project", configPath: files.project });
});

test("workflow settings reject unknown keys and sizes with the file path", () => {
  const files = paths("invalid");
  writeJson(files.user, { size: "huge" });
  assert.throws(() => resolveWorkflowSize(files), new RegExp(`Invalid workflow settings at ${files.user}: "size" must be`));

  writeJson(files.user, { size: "small", maxAgents: 3 });
  assert.throws(() => resolveWorkflowSize(files), /unexpected key "maxAgents"/);
});

test("setWorkflowSize writes only the size", () => {
  const files = paths("set");
  setWorkflowSize(files.project, "large");
  assert.deepEqual(JSON.parse(readFileSync(files.project, "utf8")), { size: "large" });
  assert.deepEqual(resolveWorkflowSize(files), { size: "large", source: "project", configPath: files.project });
});

test("each size maps to its agent guideline; off adds no line", () => {
  assert.equal(
    workflowSizeGuidelineLine("medium"),
    "Workflow size guideline: medium — keep each workflow under 10 agents unless the user asks for more; the user changes this with /workflow:size.",
  );
  assert.match(workflowSizeGuidelineLine("small") ?? "", /under 5 agents/);
  assert.match(workflowSizeGuidelineLine("large") ?? "", /under 25 agents/);
  assert.equal(workflowSizeGuidelineLine("off"), undefined);
});

test("/workflow:size parses a size and scope, and completes sizes then scopes", () => {
  assert.deepEqual(parseWorkflowSizeCommand(""), { kind: "status" });
  assert.deepEqual(parseWorkflowSizeCommand("Large"), { kind: "set", size: "large", scope: "user" });
  assert.deepEqual(parseWorkflowSizeCommand("off --project"), { kind: "set", size: "off", scope: "project" });
  assert.equal(parseWorkflowSizeCommand("huge").kind, "error");
  assert.equal(parseWorkflowSizeCommand("--project").kind, "error");
  assert.equal(parseWorkflowSizeCommand("small --user --project").kind, "error");

  assert.deepEqual(workflowSizeArgumentCompletions("")?.map((item) => item.value), ["small", "medium", "large", "off"]);
  assert.deepEqual(workflowSizeArgumentCompletions("small ")?.map((item) => item.label), ["--user", "--project"]);
  assert.equal(workflowSizeArgumentCompletions("small --user "), null);
});

test("/workflow:size updates the session's catalog line and keeps maxAgents as the hard cap", async () => {
  const extension = captureWorkflowExtension();
  const command = extension.commands.get("workflow:size");
  if (!command) throw new Error("expected /workflow:size command");
  const cwd = join(TEST_ROOT, "command");
  mkdirSync(cwd, { recursive: true });
  const notifications: string[] = [];
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "size-command" },
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext;
  const catalog = async () =>
    (await extension.beforeAgentStart({ selectedTools: ["workflow"], sections: {} }, ctx as ExtensionContext)).sections[WORKFLOWS_SECTION] ?? "";

  await command.handler("large --project", ctx);
  assert.match(notifications.at(-1) ?? "", /^Workflow size guideline: large \(project config .*\) — keep each workflow under 25 agents/);
  assert.match(notifications.at(-1) ?? "", /maxAgents run limit \(default 64\) stays the hard cap/);
  assert.match(await catalog(), /Workflow size guideline: large/);

  await command.handler("off --project", ctx);
  assert.doesNotMatch(await catalog(), /Workflow size guideline/);
});
