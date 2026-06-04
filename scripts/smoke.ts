// Standalone smoke test wrapper (no LLM calls). Run: `bun scripts/smoke.ts`
import { runCli } from "../tests/run.ts";

await runCli(["tests/discovery.test.ts"]);
