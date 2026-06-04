// No-LLM workflow UI test wrapper. Run: `bun scripts/test-workflow-ui.ts`
import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(process.execPath, ["test", "tests/workflow-ui.test.ts"], { stdio: "inherit" });

process.exitCode = await new Promise<number>((resolve) => {
  child.on("error", (error) => {
    console.error(error);
    resolve(1);
  });
  child.on("close", (code) => resolve(code ?? 1));
});
