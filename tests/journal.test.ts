import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import {
  agentJournalKey,
  createMemoryBackedJournal,
  createWorkflowJournal,
  hashAgentCall,
  loadJournalEntries,
  pruneWorkflowJournals,
  WorkflowJournalLoadError,
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

test("agentJournalKey uses optional cache keys without hiding behavior changes", () => {
  const base = agentJournalKey("inspect", { cacheKey: "stage:item-1", thinkingLevel: "low" });
  assert.equal(agentJournalKey("inspect", { cacheKey: "stage:item-1", thinkingLevel: "low" }), base);
  assert.notEqual(agentJournalKey("inspect", { cacheKey: "stage:item-2", thinkingLevel: "low" }), base);
  assert.notEqual(agentJournalKey("inspect", { cacheKey: "stage:item-1", thinkingLevel: "medium" }), base);
});

test("journal lookup matches exact stable keys without suffix invalidation", async () => {
  const journal = createMemoryBackedJournal([
    { key: "a", value: "one" },
    { key: "b", value: "two" },
    { key: "c", value: "three" },
  ]);

  assert.deepEqual(journal.lookup("a"), { hit: true, value: "one" });
  assert.deepEqual(journal.lookup("changed"), { hit: false });
  assert.deepEqual(journal.lookup("c"), { hit: true, value: "three" });
});

test("journal lookup treats duplicate keys as ambiguous misses", async () => {
  const journal = createMemoryBackedJournal([
    { key: "same", value: "one" },
    { key: "same", value: "two" },
  ]);

  assert.deepEqual(journal.lookup("same"), { hit: false });
});

test("journal records append JSONL and explicit resume load failures are visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
  const path = join(dir, "run.jsonl");
  const journal = await createWorkflowJournal({ writePath: path });

  assert.deepEqual(await journal.record("key-1", { ok: true }), { ok: true });
  assert.deepEqual(await journal.record("key-2", null), { ok: true });

  assert.deepEqual(await loadJournalEntries(path), [
    { key: "key-1", value: { ok: true } },
    { key: "key-2", value: null },
  ]);
  assert.deepEqual(await loadJournalEntries(join(dir, "missing.jsonl")), []);
  await assert.rejects(() => createWorkflowJournal({ resumePath: join(dir, "missing.jsonl"), writePath: join(dir, "next.jsonl") }), WorkflowJournalLoadError);

  await writeFile(join(dir, "corrupt.jsonl"), "{nope\n", "utf8");
  assert.deepEqual(await loadJournalEntries(join(dir, "corrupt.jsonl")), []);
  await assert.rejects(() => loadJournalEntries(join(dir, "corrupt.jsonl"), { required: true }), WorkflowJournalLoadError);

  const content = await readFile(path, "utf8");
  assert.match(content, /"key":"key-1"/);
  assert.match(content, /"key":"key-2"/);
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
