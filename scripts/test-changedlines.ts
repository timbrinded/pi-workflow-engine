// Pure-function diff line-gate wrapper (no LLM). Run: `bun scripts/test-changedlines.ts`
import { runCli } from "../tests/run.ts";

await runCli(["tests/changedlines.test.ts"]);
