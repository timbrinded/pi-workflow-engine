import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { compileInlineWorkflow } from "../.pi/extensions/pi-workflow-engine/src/inline-workflow.ts";
import { resolveWorkflowRunOptions } from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import type { WorkflowProgressSnapshot } from "../.pi/extensions/pi-workflow-engine/src/progress-types.ts";
import {
  createWorkflowRunRecord,
  isWorkflowRunRecord,
  transitionWorkflowRun,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-record.ts";
import {
  sealWorkflowRunScript,
  verifyWorkflowRunScriptSeal,
  WORKFLOW_RUN_SEAL_KEY_FILE,
} from "../.pi/extensions/pi-workflow-engine/src/workflow-run-seal.ts";

test("seals bind a run id to a fingerprint under one private key that concurrent first uses agree on", async () => {
  const agentDir = join(await mkdtemp(join(tmpdir(), "pi-workflow-seal-")), "agent");
  const otherAgentDir = await mkdtemp(join(tmpdir(), "pi-workflow-seal-other-"));
  try {
    assert.equal(await verifyWorkflowRunScriptSeal("run", "source", "0".repeat(64), agentDir), false);
    await assert.rejects(() => stat(join(agentDir, WORKFLOW_RUN_SEAL_KEY_FILE)), "verifying never creates a key");

    const seals = await Promise.all(Array.from({ length: 8 }, () => sealWorkflowRunScript("run", "source", agentDir)));
    assert.equal(new Set(seals).size, 1, "every racer seals with the key that won");
    const seal = seals[0] ?? "";
    const key = join(agentDir, WORKFLOW_RUN_SEAL_KEY_FILE);
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    assert.match(await readFile(key, "utf8"), /^[0-9a-f]{64}\n$/);

    assert.equal(await verifyWorkflowRunScriptSeal("run", "source", seal, agentDir), true);
    assert.equal(await verifyWorkflowRunScriptSeal("other-run", "source", seal, agentDir), false);
    assert.equal(await verifyWorkflowRunScriptSeal("run", "other-source", seal, agentDir), false);
    assert.equal(await verifyWorkflowRunScriptSeal("run", "source", seal.toUpperCase(), agentDir), false);
    assert.notEqual(await sealWorkflowRunScript("run", "source", otherAgentDir), seal, "another install's key seals differently");

    await writeFile(key, "not a key\n");
    await assert.rejects(sealWorkflowRunScript("run", "source", agentDir), /seal key .* is malformed/);
  } finally {
    await rm(join(agentDir, ".."), { recursive: true, force: true });
    await rm(otherAgentDir, { recursive: true, force: true });
  }
});

test("a run record keeps its script seal through transitions and rejects a malformed or orphaned one", () => {
  const progress: WorkflowProgressSnapshot = {
    runId: "sealed-record",
    title: "sealed",
    startedAt: 1,
    currentPhase: "Workflow",
    phases: [],
    counters: [],
    summary: [],
    lanes: [],
    laneOverflow: [],
    logs: [],
  };
  const seal = "a".repeat(64);
  const queued = createWorkflowRunRecord({
    runId: "sealed-record",
    workflow: compileInlineWorkflow('export const meta = { name: "sealed", description: "" };\nexport default async function run() { return 1; }\n'),
    options: resolveWorkflowRunOptions({}, {}),
    progress,
    scriptPersisted: true,
    scriptSeal: seal,
  });
  const running = transitionWorkflowRun(queued, { state: "running", progress, at: 2 });

  assert.equal(running.scriptSeal, seal);
  assert.equal(isWorkflowRunRecord(JSON.parse(JSON.stringify(running))), true);
  assert.equal(isWorkflowRunRecord({ ...running, scriptSeal: "not-hex" }), false);
  assert.equal(isWorkflowRunRecord({ ...running, scriptFile: undefined }), false, "a seal needs the script it covers");
});
