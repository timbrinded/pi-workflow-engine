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
import type { AgentResumeContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";

const RESUME_CONTEXT = {
  repository: { kind: "verified", state: "git", head: "head-a", workingTreeFingerprint: "clean" },
  workflow: { kind: "verified", name: "review", sourceFingerprint: "source-a" },
  model: { provider: "anthropic", id: "claude-a" },
} satisfies AgentResumeContext;

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

test("agentJournalKey includes the isolated worktree baseline identity", () => {
  const first = agentJournalKey(
    "fix",
    { isolation: "worktree" },
    { ref: "a".repeat(40), patch: "first patch" },
  );
  assert.notEqual(
    agentJournalKey(
      "fix",
      { isolation: "worktree" },
      { ref: "b".repeat(40), patch: "first patch" },
    ),
    first,
  );
  assert.notEqual(
    agentJournalKey(
      "fix",
      { isolation: "worktree" },
      { ref: "a".repeat(40), patch: "second patch" },
    ),
    first,
  );
});

test("journal lookup matches exact contextual keys without suffix invalidation", async () => {
  const journal = createMemoryBackedJournal([
    { key: "a", value: "one", context: RESUME_CONTEXT },
    { key: "b", value: "two", context: RESUME_CONTEXT },
    { key: "c", value: "three", context: RESUME_CONTEXT },
  ]);

  assert.deepEqual(journal.lookup("a", RESUME_CONTEXT), { hit: true, value: "one" });
  assert.deepEqual(journal.lookup("changed", RESUME_CONTEXT), { hit: false });
  assert.deepEqual(journal.lookup("c", RESUME_CONTEXT), { hit: true, value: "three" });
});

test("journal lookup treats duplicate keys as ambiguous misses", async () => {
  const journal = createMemoryBackedJournal([
    { key: "same", value: "one", context: RESUME_CONTEXT },
    { key: "same", value: "two", context: RESUME_CONTEXT },
  ]);

  assert.deepEqual(journal.lookup("same", RESUME_CONTEXT), {
    hit: false,
    reason: "multiple cached entries match this agent call",
  });
});

test("journal validates execution context and explains cache invalidation", () => {
  const journal = createMemoryBackedJournal([{ key: "same", value: "cached", context: RESUME_CONTEXT }]);

  assert.deepEqual(journal.lookup("same", RESUME_CONTEXT), { hit: true, value: "cached" });
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      repository: { ...RESUME_CONTEXT.repository, head: "head-b" },
    }),
    { hit: false, reason: "repository HEAD changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      repository: { ...RESUME_CONTEXT.repository, workingTreeFingerprint: "dirty-b" },
    }),
    { hit: false, reason: "working tree contents changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      workflow: { ...RESUME_CONTEXT.workflow, sourceFingerprint: "source-b" },
    }),
    { hit: false, reason: "workflow source changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      workflow: { kind: "unverifiable", name: "review", reason: "test fixture" },
    }),
    { hit: false, reason: "workflow source could not be verified" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      model: { provider: "openai", id: "gpt-a" },
    }),
    { hit: false, reason: "effective model changed" },
  );
});

test("context-aware lookup never replays legacy journal entries", () => {
  const journal = createMemoryBackedJournal([{ key: "legacy", value: "stale" }]);

  assert.deepEqual(journal.lookup("legacy", RESUME_CONTEXT), {
    hit: false,
    reason: "legacy journal entry has no execution context",
  });
});

test("journal records append JSONL and explicit resume load failures are visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
  const path = join(dir, "run.jsonl");
  const journal = await createWorkflowJournal({ writePath: path });

  assert.deepEqual(await journal.record("key-1", { ok: true }, RESUME_CONTEXT), { ok: true });
  assert.deepEqual(await journal.record("key-2", null, RESUME_CONTEXT), { ok: true });

  assert.deepEqual(await loadJournalEntries(path), [
    { key: "key-1", value: { ok: true }, context: RESUME_CONTEXT },
    { key: "key-2", value: null, context: RESUME_CONTEXT },
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
