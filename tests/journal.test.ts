import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import {
  createMemoryBackedJournal,
  createWorkflowJournal,
  hashAgentCall,
  loadJournalEntries,
  pruneWorkflowJournals,
  WORKFLOW_RUNS_DIR,
  workflowJournalPath,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";

test("hashAgentCall is stable for equivalent behavioral options", () => {
  const schemaA = Type.Object({ ok: Type.Boolean(), value: Type.String() });
  const schemaB = { ...schemaA, properties: { value: schemaA.properties.value, ok: schemaA.properties.ok } };

  const first = hashAgentCall("inspect", {
    label: "first",
    phase: "Find",
    schema: schemaA,
    tools: ["grep", "read"],
    toolHints: ["search"],
    skills: ["beta", "alpha"],
    thinkingLevel: "low",
  });
  const second = hashAgentCall("inspect", {
    label: "second",
    phase: "Verify",
    schema: schemaB,
    tools: ["read", "grep"],
    toolHints: ["search"],
    skills: ["alpha", "beta"],
    thinkingLevel: "low",
  });

  assert.equal(first, second);
});

test("hashAgentCall changes when behavioral inputs change", () => {
  const base = hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read"] });

  assert.notEqual(hashAgentCall("inspect again", { thinkingLevel: "low", tools: ["read"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "medium", tools: ["read"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read", "grep"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read"], schema: Type.Object({ ok: Type.Boolean() }) }), base);
});

test("journal lookup requires both index and hash and invalidates the suffix after first miss", async () => {
  const journal = createMemoryBackedJournal([
    { index: 1, hash: "a", value: "one" },
    { index: 2, hash: "b", value: "two" },
    { index: 3, hash: "c", value: "three" },
  ]);

  assert.deepEqual(journal.lookup(1, "a"), { hit: true, value: "one" });
  assert.deepEqual(journal.lookup(2, "changed"), { hit: false });
  assert.deepEqual(journal.lookup(3, "c"), { hit: false });
});

test("journal records append JSONL and load ignores missing or corrupt data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
  const path = join(dir, "run.jsonl");
  const journal = await createWorkflowJournal({ writePath: path });

  await journal.record(1, "hash", { ok: true });
  await journal.record(2, "hash-2", null);

  assert.deepEqual(await loadJournalEntries(path), [
    { index: 1, hash: "hash", value: { ok: true } },
    { index: 2, hash: "hash-2", value: null },
  ]);
  assert.deepEqual(await loadJournalEntries(join(dir, "missing.jsonl")), []);

  await writeFile(join(dir, "corrupt.jsonl"), "{nope\n", "utf8");
  assert.deepEqual(await loadJournalEntries(join(dir, "corrupt.jsonl")), []);

  const content = await readFile(path, "utf8");
  assert.match(content, /"index":1/);
  assert.match(content, /"index":2/);
});

test("workflowJournalPath validates run ids and pruneWorkflowJournals keeps newest files", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-journal-prune-"));
  const dir = join(cwd, WORKFLOW_RUNS_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(workflowJournalPath(cwd, "old"), "old\n", "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(workflowJournalPath(cwd, "new"), "new\n", "utf8");

  await pruneWorkflowJournals(cwd, 1);

  await assert.rejects(() => readFile(join(dir, "old.jsonl"), "utf8"));
  assert.equal(await readFile(join(dir, "new.jsonl"), "utf8"), "new\n");
  assert.throws(() => workflowJournalPath(cwd, "../bad"), /Workflow run id/);
});
