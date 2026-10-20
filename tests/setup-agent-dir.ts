import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";

// Engine code writes under pi's agent dir (the run-seal key, user workflow settings), so the suite
// points it at a throwaway directory instead of the developer's ~/.pi/agent.
if (process.env.PI_CODING_AGENT_DIR === undefined) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-workflow-test-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // A hook registered in a preload runs once, after every test file.
  afterAll(() => rmSync(agentDir, { recursive: true, force: true }));
}
