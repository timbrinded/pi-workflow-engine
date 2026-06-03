// Standalone smoke test (no LLM calls): verifies the module graph loads and the
// workflow registry/discovery resolves. Run: `bun scripts/smoke.ts`
import { fileURLToPath } from "node:url";
import { discoverWorkflows } from "../src/discovery.ts";

const repoDir = fileURLToPath(new URL("..", import.meta.url));
const workflows = await discoverWorkflows(repoDir);

console.log(`Discovered ${workflows.size} workflow(s):`);
for (const mod of workflows.values()) {
  console.log(`  - ${mod.meta.name}: ${mod.meta.description}`);
  console.log(`    phases: ${(mod.meta.phases ?? []).map((p) => p.title).join(" → ") || "(none)"}`);
  console.log(`    default export is function: ${typeof mod.default === "function"}`);
}
