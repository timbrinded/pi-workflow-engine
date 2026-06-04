// No-LLM workflow UI test wrapper. Run: `bun scripts/test-workflow-ui.ts`
import { runCli } from "../tests/run.ts";

await runCli(["tests/workflow-ui.test.ts"]);
