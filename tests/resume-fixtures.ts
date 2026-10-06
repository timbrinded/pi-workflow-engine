import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureAgentJournalKey } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";

export function runGit(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

export async function createGitRepo(options: { readonly ignoreJournal?: boolean } = {}): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-resume-context-"));
  runGit(cwd, ["init"]);
  await writeFile(join(cwd, "tracked.txt"), "baseline\n", "utf8");
  if (options.ignoreJournal !== false) {
    await writeFile(join(cwd, ".gitignore"), ".pi/.workflow-runs/\n", "utf8");
  }
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-m", "baseline"]);
  return cwd;
}

/** The journal key production records, failing the test if the call cannot be keyed. */
export function verifiedJournalKey(...args: Parameters<typeof captureAgentJournalKey>): string {
  const capture = captureAgentJournalKey(...args);
  if (capture.kind !== "verified") assert.fail(`expected a verified journal key: ${capture.reason}`);
  return capture.key;
}
