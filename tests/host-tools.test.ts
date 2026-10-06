import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createHostToolBridge } from "../.pi/extensions/pi-workflow-engine/src/host-tools.ts";
import { createToolInfo } from "./agent-runner-fixtures.ts";

test("the host bridge offers only MCP tools the host can currently call, and forwards calls with the agent's signal", async () => {
  const forwarded: Array<{ name: string; args: unknown; signal: AbortSignal | undefined }> = [];
  const callable = (name: string): AgentTool => ({ name, label: name, description: name, parameters: createToolInfo(name).parameters, execute: async () => ({ content: [], details: undefined }) });
  const bridge = createHostToolBridge(
    () => [createToolInfo("mcp__docs__search"), createToolInfo("mcp__offline__search"), createToolInfo("bash")],
    {
      tools: [callable("mcp__docs__search"), callable("bash")],
      async executeTool(name, args, options) {
        forwarded.push({ name, args, signal: options?.signal });
        return { toolCall: { type: "toolCall", id: "parent/1", name, arguments: {} }, result: { content: [], details: undefined }, isError: false };
      },
    },
  );

  assert.deepEqual(bridge.tools().map((tool) => tool.name), ["mcp__docs__search"]);
  const signal = new AbortController().signal;
  await bridge.execute("mcp__docs__search", { q: "x" }, signal);
  assert.deepEqual(forwarded, [{ name: "mcp__docs__search", args: { q: "x" }, signal }]);
});
