import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowAgentLimiter } from "../.pi/extensions/pi-workflow-engine/src/agent-limits.ts";
import { defaultAgentRetryScheduler } from "../.pi/extensions/pi-workflow-engine/src/agent-retry.ts";
import {
  FINAL_TOOL,
  openAgentSession,
} from "../.pi/extensions/pi-workflow-engine/src/agent-session.ts";
import type { RunContext } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { createBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { createMemoryBackedJournal } from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import { hostWorkflowModelProfiles } from "../.pi/extensions/pi-workflow-engine/src/model-profiles.ts";
import {
  DEFAULT_WORKFLOW_AGENT_RETRIES,
  DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_MAX_AGENTS,
} from "../.pi/extensions/pi-workflow-engine/src/options.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { WorktreeRegistry } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import {
  createProgress,
  testModel,
} from "./agent-runner-fixtures.ts";

test("production session services load selected skills and wire built-in and custom tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-session-services-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const skillDir = join(cwd, ".pi", "skills", "runtime-fixture");
  const skillPath = join(skillDir, "SKILL.md");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  let session: Awaited<ReturnType<typeof openAgentSession>>["session"] | undefined;

  try {
    await mkdir(skillDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: runtime-fixture\ndescription: Verifies production session service wiring.\n---\n\n# Runtime fixture\n",
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";

    const hostRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "missing-auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const usage = createWorkflowUsageRecorder();
    const model = testModel("test", "offline-session-services");
    const rc: RunContext = {
      cwd,
      hostModel: model,
      modelRegistry: new ModelRegistry(hostRuntime),
      semaphore: new Semaphore(1),
      agentLimiter: new WorkflowAgentLimiter(DEFAULT_WORKFLOW_MAX_AGENTS),
      agentTimeoutMs: DEFAULT_WORKFLOW_AGENT_TIMEOUT_MS,
      agentRetries: DEFAULT_WORKFLOW_AGENT_RETRIES,
      retryScheduler: defaultAgentRetryScheduler,
      modelProfiles: hostWorkflowModelProfiles(model),
      progress: createProgress(),
      signal: undefined,
      perf: new PerfRecorder(),
      usage,
      budget: createBudget(null, usage),
      journal: createMemoryBackedJournal(),
      worktrees: new WorktreeRegistry(cwd),
    };

    const handle = await openAgentSession({
      rc,
      prompt: "Use the runtime-fixture skill.",
      opts: {
        label: "session-services",
        skills: ["runtime-fixture"],
        tools: ["read"],
        schema: Type.Object({ ok: Type.Boolean() }),
      },
      cwd,
      model,
      label: "session-services",
      tags: { label: "session-services", phase: "Test" },
    });
    session = handle.session;

    assert.deepEqual(handle.selectedSkills.map((skill) => skill.name), ["runtime-fixture"]);
    assert.equal(handle.selectedSkills[0]?.filePath, skillPath);
    assert.match(session.systemPrompt, /runtime-fixture/);
    assert.equal(session.model, model);
    assert.ok(session.getActiveToolNames().includes("read"));
    assert.ok(session.getActiveToolNames().includes(FINAL_TOOL));
    assert.ok(session.getToolDefinition("read"));
    assert.ok(session.getToolDefinition(FINAL_TOOL));
  } finally {
    session?.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  }
});
