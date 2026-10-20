import assert from "node:assert/strict";
import { test } from "bun:test";
import { workflowToolReach } from "../.pi/extensions/pi-workflow-engine/src/workflow-tool-reach.ts";
import { captureWorkflowExtension } from "./workflow-extension-fixtures.ts";

const NO_FILES = (path: string): string => {
  throw new Error(`unexpected read of ${path}`);
};

const MCP_SCRIPT = `export const meta = { name: "mcp-probe", description: "" };
export default async function run({ agent }) {
  const issues = await agent("List issues", { tools: ["mcp__linear__list_issues", "read"], profile: "small" });
  return agent(\`Search docs for \${issues}\`, { tools: ["mcp__docs__search", "mcp__linear__list_issues"], profile: "small" });
}`;

test("an inline script reaches each MCP tool it names, once", () => {
  assert.deepEqual(workflowToolReach({ script: MCP_SCRIPT }, NO_FILES), ["mcp__linear__list_issues", "mcp__docs__search"]);
  assert.deepEqual(workflowToolReach({ script: 'export const meta = { name: "local" }; export default async () => { return 1; }' }, NO_FILES), []);
});

test("external-search hints and sub-workflows make a script reach every server", () => {
  const hinted = 'export default async ({ agent }) => { return agent("q", { toolHints: ["external-search"] }); }';
  const composed = 'export default async (api) => { return api.workflow("research", "q"); }';
  const destructured = "export default async ({ workflow }) => { return workflow ( { scriptPath: 'x.js' } ); }";

  assert.equal(workflowToolReach({ script: hinted }, NO_FILES), "all");
  assert.equal(workflowToolReach({ script: composed }, NO_FILES), "all");
  assert.equal(workflowToolReach({ script: destructured }, NO_FILES), "all");
});

test("a named workflow reaches every server; a background run or an invalid call reaches none", () => {
  assert.equal(workflowToolReach({ name: "research" }, NO_FILES), "all");
  assert.deepEqual(workflowToolReach({ name: "research", background: true }, NO_FILES), []);
  assert.deepEqual(workflowToolReach({ script: MCP_SCRIPT, background: true }, NO_FILES), []);
  assert.deepEqual(workflowToolReach({ name: "research", script: MCP_SCRIPT }, NO_FILES), []);
  assert.deepEqual(workflowToolReach({ name: "  " }, NO_FILES), []);
});

test("a script file is scanned like a script, and an unreadable one reaches every server", () => {
  const reads: string[] = [];
  const files = (path: string): string => {
    reads.push(path);
    if (path === "scripts/mcp.js") return MCP_SCRIPT;
    throw new Error("ENOENT");
  };

  assert.deepEqual(workflowToolReach({ scriptPath: " scripts/mcp.js " }, files), ["mcp__linear__list_issues", "mcp__docs__search"]);
  assert.equal(workflowToolReach({ scriptPath: "scripts/missing.js" }, files), "all");
  assert.deepEqual(reads, ["scripts/mcp.js", "scripts/missing.js"]);
});

test("the workflow tool declares its reach to pi", () => {
  const { tool } = captureWorkflowExtension();
  assert.equal(tool.reachesTools?.({ name: "code-review" }), "all");
  assert.equal(tool.reachesTools?.({ scriptPath: "does/not/exist.js" }), "all");
});
