import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatWorkflowCatalog, WORKFLOWS_SECTION, WorkflowCatalogPrompt } from "../.pi/extensions/pi-workflow-engine/src/workflow-catalog.ts";
import { BUILTIN_WORKFLOW_DEFINITIONS } from "../.pi/extensions/pi-workflow-engine/src/workflows.ts";
import type { WorkflowMeta } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import type { WorkflowSizeGuideline } from "../.pi/extensions/pi-workflow-engine/src/workflow-settings.ts";
import { captureWorkflowExtension } from "./workflow-extension-fixtures.ts";

function sessionContext(sessionId: string, cwd = process.cwd(), trusted = true): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

test("the catalog lists workflows by name with their description and when to use them", () => {
  const catalog = formatWorkflowCatalog([
    { name: "zeta", description: "Last one.", whenToUse: "Use for z." },
    { name: "alpha", description: "First one." },
  ]);

  assert.ok(catalog);
  const lines = catalog.split("\n");
  assert.equal(lines[1], "- alpha: First one.");
  assert.equal(lines[2], "- zeta: Last one. Use for z.");
  assert.equal(formatWorkflowCatalog([]), undefined);
});

test("every built-in workflow says when to use it", () => {
  for (const { module } of BUILTIN_WORKFLOW_DEFINITIONS) {
    assert.ok(module.meta.whenToUse?.trim(), `${module.meta.name} needs meta.whenToUse for the catalog`);
  }
});

test("the catalog is built once per session and rebuilt only after the session is forgotten", async () => {
  let discoveries = 0;
  const workflows: WorkflowMeta[] = [{ name: "one", description: "First." }];
  const catalog = new WorkflowCatalogPrompt({
    async discover() {
      discoveries++;
      return workflows;
    },
    size: () => "off",
  });
  const ctx = sessionContext("catalog-cache");

  const first = await catalog.section(ctx);
  workflows.push({ name: "two", description: "Added mid-session." });
  assert.equal(await catalog.section(ctx), first, "a cached session keeps identical text");
  assert.equal(discoveries, 1);

  catalog.forget(ctx);
  assert.match((await catalog.section(ctx)) ?? "", /- two: Added mid-session\./);
  assert.equal(discoveries, 2);
});

test("a discovery failure leaves the catalog out instead of failing the prompt", async () => {
  const logs: string[] = [];
  const catalog = new WorkflowCatalogPrompt({
    async discover() {
      throw new Error("disk on fire");
    },
    size: () => "off",
    log: (message) => logs.push(message),
  });

  assert.equal(await catalog.section(sessionContext("catalog-failure")), undefined);
  assert.match(logs[0] ?? "", /workflow catalog unavailable: disk on fire/);
});

test("the size guideline closes the catalog, falls back to the default, and is left out when off", async () => {
  const logs: string[] = [];
  const workflows: WorkflowMeta[] = [{ name: "one", description: "First." }];
  const render = (size: () => WorkflowSizeGuideline) =>
    new WorkflowCatalogPrompt({ discover: async () => workflows, size, log: (message) => logs.push(message) }).section(sessionContext("catalog-size"));

  const large = (await render(() => "large")) ?? "";
  assert.match(large, /- one: First\.\n\nWorkflow size guideline: large — keep each workflow under 25 agents unless the user asks for more; the user changes this with \/workflow:size\.$/);
  assert.doesNotMatch((await render(() => "off")) ?? "", /size guideline/);
  const fallback = await render(() => {
    throw new Error("bad settings");
  });
  assert.match(fallback ?? "", /Workflow size guideline: medium — keep each workflow under 10 agents/);
  assert.match(logs.at(-1) ?? "", /using medium: bad settings/);
});

test("runs that can call the workflow tool get the same catalog section every turn", async () => {
  const extension = captureWorkflowExtension();
  const ctx = sessionContext("catalog-extension");

  const first = await extension.beforeAgentStart({ selectedTools: ["read", "workflow"], sections: {} }, ctx);
  const catalog = first.sections[WORKFLOWS_SECTION] ?? "";
  for (const { module } of BUILTIN_WORKFLOW_DEFINITIONS) {
    assert.ok(catalog.includes(`- ${module.meta.name}: ${module.meta.description} ${module.meta.whenToUse}`));
  }
  assert.equal(first.forceSystemPrompt, undefined, "a section patch keeps pi's cached prompt head");

  const second = await extension.beforeAgentStart({ selectedTools: ["read", "workflow"], sections: {} }, ctx);
  assert.equal(second.sections[WORKFLOWS_SECTION], catalog);

  // Subagent sessions withhold the workflow tool, so their prompts carry no catalog.
  const subagent = await extension.beforeAgentStart({ selectedTools: ["read"], sections: {} }, sessionContext("catalog-subagent"));
  assert.equal(subagent.sections[WORKFLOWS_SECTION], undefined);
});

test("a trusted project's saved workflows join the catalog", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflow-catalog-project-"));
  try {
    mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "workflows", "project-probe.js"),
      'export const meta = { name: "project-probe", description: "Project probe.", whenToUse: "Use in tests." };\nexport default async function run() { return null; }\n',
    );
    const extension = captureWorkflowExtension();
    const sectionFor = async (sessionId: string, trusted: boolean) =>
      (await extension.beforeAgentStart({ selectedTools: ["workflow"], sections: {} }, sessionContext(sessionId, cwd, trusted))).sections[WORKFLOWS_SECTION] ?? "";

    assert.match(await sectionFor("catalog-project-trusted", true), /- project-probe: Project probe\. Use in tests\./);
    assert.doesNotMatch(await sectionFor("catalog-project-untrusted", false), /project-probe/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the catalog is appended to a prompt an earlier extension forced", async () => {
  const extension = captureWorkflowExtension();
  const forced = await extension.beforeAgentStart(
    { selectedTools: ["workflow"], sections: {}, forceSystemPrompt: "Forced." },
    sessionContext("catalog-forced"),
  );

  assert.match(forced.forceSystemPrompt ?? "", new RegExp(`^Forced\\.\\n\\n<${WORKFLOWS_SECTION}>\\nRegistered workflows[\\s\\S]*</${WORKFLOWS_SECTION}>$`));
});
