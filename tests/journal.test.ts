import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { Type } from "typebox";
import {
  agentJournalKey,
  captureAgentJournalKey,
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
  session: {
    fingerprint: "sha256:session-a",
    runtimeVersion: "test-runtime",
    systemPromptFingerprint: "sha256:prompt-a",
    model: { provider: "anthropic", id: "claude-a" },
    thinkingLevel: "low",
    tools: [
      {
        name: "read",
        definitionFingerprint: "sha256:definition-a",
        implementationFingerprint: "sha256:implementation-a",
        source: {
          path: "builtin:read",
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
          fingerprint: "sha256:source-a",
        },
      },
    ],
  },
  skills: [{ name: "review", path: "/skills/review", fingerprint: "skill-a" }],
} satisfies AgentResumeContext;

test("hashAgentCall is stable for equivalent behavioral options", () => {
  const schemaA = Type.Object({ ok: Type.Boolean(), value: Type.String() });
  const schemaB = Type.Object({ ok: Type.Boolean(), value: Type.String() });
  schemaB.properties = { value: schemaB.properties.value, ok: schemaB.properties.ok };

  const first = hashAgentCall("inspect", {
    label: "first",
    phase: "Find",
    schema: schemaA,
    tools: ["grep", "read"],
    toolHints: ["search"],
    skills: ["alpha", "beta"],
    thinkingLevel: "low",
  });
  const second = hashAgentCall("inspect", {
    label: "second",
    phase: "Verify",
    schema: schemaB,
    tools: ["grep", "read"],
    toolHints: ["search"],
    skills: ["alpha", "beta"],
    thinkingLevel: "low",
  });

  assert.equal(first, second);
});

test("hashAgentCall preserves authored tool and skill ordering", () => {
  const first = hashAgentCall("inspect", {
    tools: ["read", "grep"],
    toolHints: ["search"],
    skills: ["alpha", "beta"],
  });

  assert.notEqual(hashAgentCall("inspect", { tools: ["grep", "read"], toolHints: ["search"], skills: ["alpha", "beta"] }), first);
  assert.notEqual(hashAgentCall("inspect", { tools: ["read", "grep"], toolHints: ["search"], skills: ["beta", "alpha"] }), first);
});

test("captureAgentJournalKey fails closed for cyclic, accessor, and oversized schemas", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual(captureAgentJournalKey("inspect", { schema: cyclic }), {
    kind: "unverifiable",
    reason: "identity contains a cycle",
  });

  const accessor = Object.defineProperty({}, "type", {
    enumerable: true,
    get() {
      throw new Error("must not execute schema accessors");
    },
  });
  assert.deepEqual(captureAgentJournalKey("inspect", { schema: accessor }), {
    kind: "unverifiable",
    reason: "identity property type is an accessor",
  });

  const oversized = captureAgentJournalKey("inspect", { schema: { description: "x".repeat((1 << 20) + 1) } });
  assert.equal(oversized.kind, "unverifiable");
  if (oversized.kind !== "unverifiable") assert.fail("expected oversized identity to be rejected");
  assert.match(oversized.reason, /identity exceeded/);
  assert.doesNotThrow(() => agentJournalKey("inspect", { schema: cyclic }));
});

test("hashAgentCall changes when behavioral inputs change", () => {
  const base = hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read"] });

  assert.notEqual(hashAgentCall("inspect again", { thinkingLevel: "low", tools: ["read"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "medium", tools: ["read"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read", "grep"] }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read"], schema: Type.Object({ ok: Type.Boolean() }) }), base);
  assert.notEqual(hashAgentCall("inspect", { thinkingLevel: "low", tools: ["read"], requireToolHints: true }), base);
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
    { version: 2, key: "a", result: "one", identity: RESUME_CONTEXT },
    { version: 2, key: "b", result: "two", identity: RESUME_CONTEXT },
    { version: 2, key: "c", result: "three", identity: RESUME_CONTEXT },
  ]);

  assert.deepEqual(journal.lookup("a", RESUME_CONTEXT), { hit: true, value: "one" });
  assert.deepEqual(journal.lookup("changed", RESUME_CONTEXT), { hit: false });
  assert.deepEqual(journal.lookup("c", RESUME_CONTEXT), { hit: true, value: "three" });
});

test("journal lookup treats duplicate keys as ambiguous misses", async () => {
  const journal = createMemoryBackedJournal([
    { version: 2, key: "same", result: "one", identity: RESUME_CONTEXT },
    { version: 2, key: "same", result: "two", identity: RESUME_CONTEXT },
  ]);

  assert.deepEqual(journal.lookup("same", RESUME_CONTEXT), {
    hit: false,
    reason: "multiple cached entries match this agent call",
  });
});

test("journal validates execution context and explains cache invalidation", () => {
  const journal = createMemoryBackedJournal([{ version: 2, key: "same", result: "cached", identity: RESUME_CONTEXT }]);

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
      session: {
        ...RESUME_CONTEXT.session,
        model: { provider: "openai", id: "gpt-a" },
      },
    }),
    { hit: false, reason: "effective model changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      skills: [{ ...RESUME_CONTEXT.skills[0]!, fingerprint: "skill-b" }],
    }),
    { hit: false, reason: "resolved skills changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...RESUME_CONTEXT,
      session: {
        ...RESUME_CONTEXT.session,
        fingerprint: "sha256:session-b",
        tools: [
          {
            ...RESUME_CONTEXT.session.tools[0]!,
            definitionFingerprint: "sha256:definition-b",
          },
        ],
      },
    }),
    { hit: false, reason: "effective tools or session state changed" },
  );
});

test("edited-workflow lookup waives only source fingerprint mismatch", () => {
  const journal = createMemoryBackedJournal([{ version: 2, key: "same", result: "cached", identity: RESUME_CONTEXT }]);
  const edited = {
    ...RESUME_CONTEXT,
    workflow: { ...RESUME_CONTEXT.workflow, sourceFingerprint: "source-b" },
  } satisfies AgentResumeContext;
  assert.deepEqual(journal.lookup("same", edited), { hit: false, reason: "workflow source changed" });
  assert.deepEqual(journal.lookup("same", edited, { allowWorkflowSourceMismatch: true }), { hit: true, value: "cached" });
  assert.deepEqual(
    journal.lookup("same", {
      ...edited,
      repository: { ...edited.repository, head: "head-b" },
    }, { allowWorkflowSourceMismatch: true }),
    { hit: false, reason: "repository HEAD changed" },
  );
  assert.deepEqual(
    journal.lookup("same", {
      ...edited,
      session: { ...edited.session, model: { provider: "openai", id: "gpt-b" } },
    }, { allowWorkflowSourceMismatch: true }),
    { hit: false, reason: "effective model changed" },
  );
});

test("context-aware lookup never replays legacy journal entries", () => {
  const journal = createMemoryBackedJournal([
    { key: "legacy", value: "stale" },
    {
      version: 2,
      key: "old-v2",
      result: "stale",
      identity: {
        repository: RESUME_CONTEXT.repository,
        workflow: RESUME_CONTEXT.workflow,
        model: RESUME_CONTEXT.session.model,
        skills: [],
        tools: [],
      },
    },
    {
      version: 2,
      key: "unverified-v2",
      result: "stale",
      identity: {
        ...RESUME_CONTEXT,
        workflow: { kind: "unverifiable", name: "review", reason: "test fixture" },
      },
    },
  ]);

  assert.deepEqual(journal.lookup("legacy", RESUME_CONTEXT), {
    hit: false,
    reason: "journal entry predates replay contract v2",
  });
  assert.deepEqual(journal.lookup("old-v2", RESUME_CONTEXT), {
    hit: false,
    reason: "journal entry predates effective replay identity",
  });
  assert.deepEqual(journal.lookup("unverified-v2", RESUME_CONTEXT), {
    hit: false,
    reason: "journal entry predates effective replay identity",
  });
});

test("journal records append JSONL and explicit resume load failures are visible", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
  const path = join(dir, "run.jsonl");
  const journal = await createWorkflowJournal({ writePath: path });

  assert.deepEqual(await journal.record("key-1", { ok: true }, RESUME_CONTEXT), { ok: true });
  assert.deepEqual(await journal.record("key-2", null, RESUME_CONTEXT), { ok: true });

  assert.deepEqual(await loadJournalEntries(path), [
    { version: 2, key: "key-1", result: { ok: true }, identity: RESUME_CONTEXT },
    { version: 2, key: "key-2", result: null, identity: RESUME_CONTEXT },
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
