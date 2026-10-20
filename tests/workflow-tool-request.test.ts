import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { workflowToolReach } from "../.pi/extensions/pi-workflow-engine/src/workflow-tool-request.ts";
import { captureWorkflowExtension } from "./workflow-extension-fixtures.ts";

const MCP_SCRIPT = `export const meta = { name: "mcp-probe", description: "" };
export default async function run({ agent }) {
  const issues = await agent("List issues", { tools: ["mcp__linear__list_issues", "read"], profile: "small" });
  return agent(\`Search docs for \${issues}\`, { tools: ["mcp__docs__search", "mcp__linear__list_issues"], profile: "small" });
}`;

test("an inline script reaches each MCP tool it names, once", () => {
  assert.deepEqual(workflowToolReach({ script: MCP_SCRIPT }), ["mcp__linear__list_issues", "mcp__docs__search"]);
  assert.deepEqual(workflowToolReach({ script: 'export const meta = { name: "local" }; export default async () => { return 1; }' }), []);
});

test("external-search hints and sub-workflows make a script reach every server", () => {
  const hinted = 'export default async ({ agent }) => { return agent("q", { toolHints: ["external-search"] }); }';
  const composed = 'export default async (api) => { return api.workflow("research", "q"); }';
  const destructured = "export default async ({ workflow }) => { return workflow ( { scriptPath: 'x.js' } ); }";

  assert.equal(workflowToolReach({ script: hinted }), "all");
  assert.equal(workflowToolReach({ script: composed }), "all");
  assert.equal(workflowToolReach({ script: destructured }), "all");
});

test("a named workflow reaches every server; a background run or an invalid call reaches none", () => {
  assert.equal(workflowToolReach({ name: "research" }), "all");
  assert.deepEqual(workflowToolReach({ name: "research", background: true }), []);
  assert.deepEqual(workflowToolReach({ script: MCP_SCRIPT, background: true }), []);
  assert.deepEqual(workflowToolReach({ name: "research", script: MCP_SCRIPT }), []);
  assert.deepEqual(workflowToolReach({ name: "  " }), []);
});

test("a script file reaches every server unread, since pi asks on its main thread", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflow-reach-"));
  try {
    const scriptPath = join(dir, "mcp.js");
    writeFileSync(scriptPath, MCP_SCRIPT);
    const { tool } = captureWorkflowExtension();

    // A scan would have narrowed this file to the two servers it names.
    assert.equal(tool.reachesTools?.({ scriptPath }), "all");
    assert.equal(tool.reachesTools?.({ scriptPath: "/dev/zero" }), "all");
    assert.deepEqual(tool.reachesTools?.({ scriptPath, background: true }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the workflow tool declares its reach to pi", () => {
  const { tool } = captureWorkflowExtension();
  assert.equal(tool.reachesTools?.({ name: "code-review" }), "all");
  assert.equal(tool.reachesTools?.({ scriptPath: "does/not/exist.js" }), "all");
});
