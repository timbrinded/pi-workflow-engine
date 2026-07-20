import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  type ProviderConfig,
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
import { createProgress } from "./agent-runner-fixtures.ts";

test("production session services load skills, tools, and host runtime providers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-session-services-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const skillDir = join(cwd, ".pi", "skills", "runtime-fixture");
  const skillPath = join(skillDir, "SKILL.md");
  const extensionDir = join(cwd, ".pi", "extensions");
  const extensionPath = join(extensionDir, "provider-fixture.js");
  const modelDefinition: NonNullable<ProviderConfig["models"]>[number] = {
    id: "runtime-only-model",
    name: "Runtime-only model",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
  const startupProvider: ProviderConfig = {
    baseUrl: "https://startup.invalid",
    apiKey: "startup-key",
    api: "anthropic-messages",
    headers: { "x-startup": "present" },
    models: [modelDefinition],
  };
  const currentProvider: ProviderConfig = {
    baseUrl: "https://runtime-only.invalid",
    api: "anthropic-messages",
    models: [modelDefinition],
  };
  const removedProvider: ProviderConfig = {
    baseUrl: "https://removed.invalid",
    apiKey: "removed-key",
    api: "anthropic-messages",
    models: [{ ...modelDefinition, id: "removed-model", name: "Removed model" }],
  };
  const storedProvider: ProviderConfig = {
    baseUrl: "https://stored-only.invalid",
    api: "anthropic-messages",
    models: [{ ...modelDefinition, id: "stored-only-model", name: "Stored-only model" }],
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOffline = process.env.PI_OFFLINE;
  const sessions: Array<Awaited<ReturnType<typeof openAgentSession>>["session"]> = [];

  try {
    await mkdir(skillDir, { recursive: true });
    await mkdir(extensionDir, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      skillPath,
      "---\nname: runtime-fixture\ndescription: Verifies production session service wiring.\n---\n\n# Runtime fixture\n",
      "utf8",
    );
    await writeFile(
      extensionPath,
      `export default function (pi) {
  pi.registerProvider("runtime-only", ${JSON.stringify(startupProvider)});
  pi.registerProvider("removed-provider", ${JSON.stringify(removedProvider)});
}
`,
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";

    const credentials = new InMemoryCredentialStore();
    await credentials.modify("stored-only", async () => ({ type: "api_key", key: "stored-only-key" }));
    await credentials.modify("openai-codex", async () => ({
      type: "oauth",
      refresh: "oauth-refresh",
      access: "oauth-access",
      expires: Date.now() + 60 * 60 * 1000,
    }));
    const hostRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    hostRuntime.registerProvider("runtime-only", startupProvider);
    hostRuntime.unregisterProvider("runtime-only");
    hostRuntime.registerProvider("runtime-only", currentProvider);
    await hostRuntime.setRuntimeApiKey("runtime-only", "runtime-only-key");
    hostRuntime.registerProvider("removed-provider", removedProvider);
    hostRuntime.unregisterProvider("removed-provider");
    hostRuntime.registerProvider("stored-only", storedProvider);
    const hostRegistry = new ModelRegistry(hostRuntime);
    assert.equal(hostRegistry.getProviderAuthStatus("runtime-only").source, "runtime");
    assert.equal(hostRegistry.getProviderAuthStatus("stored-only").source, "stored");
    const model = hostRegistry.find("runtime-only", "runtime-only-model");
    const storedModel = hostRegistry.find("stored-only", "stored-only-model");
    const oauthModel = hostRegistry.find("openai-codex", "gpt-5.4");
    assert.ok(model);
    assert.ok(storedModel);
    assert.ok(oauthModel);
    assert.equal(hostRegistry.isUsingOAuth(oauthModel), true);
    const usage = createWorkflowUsageRecorder();
    const rc: RunContext = {
      cwd,
      hostModel: model,
      modelRegistry: hostRegistry,
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

    const openSession = (selectedModel: typeof model, label: string) =>
      openAgentSession({
        rc,
        prompt: "Use the runtime-fixture skill.",
        opts: {
          label,
          skills: ["runtime-fixture"],
          tools: ["read"],
          schema: Type.Object({ ok: Type.Boolean() }),
        },
        cwd,
        model: selectedModel,
        label,
        tags: { label, phase: "Test" },
      });
    const handle = await openSession(model, "session-services");
    const session = handle.session;
    sessions.push(session);

    assert.deepEqual(handle.selectedSkills.map((skill) => skill.name), ["runtime-fixture"]);
    assert.equal(handle.selectedSkills[0]?.filePath, skillPath);
    assert.match(session.systemPrompt, /runtime-fixture/);
    assert.equal(session.model, model);
    assert.ok(session.getActiveToolNames().includes("read"));
    assert.ok(session.getActiveToolNames().includes(FINAL_TOOL));
    assert.ok(session.getToolDefinition("read"));
    assert.ok(session.getToolDefinition(FINAL_TOOL));
    assert.ok("modelRuntime" in session);
    assert.ok(session.modelRuntime instanceof ModelRuntime);
    const childProvider = session.modelRuntime.getRegisteredProviderConfig("runtime-only");
    assert.equal(childProvider?.baseUrl, currentProvider.baseUrl);
    assert.equal(childProvider?.apiKey, undefined);
    assert.equal(childProvider?.headers, undefined);
    assert.equal(session.modelRuntime.getRegisteredProviderConfig("removed-provider"), undefined);
    assert.equal(session.modelRuntime.getProviderAuthStatus("runtime-only").source, "runtime");
    assert.equal((await session.modelRuntime.getAuth(model))?.auth.apiKey, "runtime-only-key");

    const storedHandle = await openSession(storedModel, "stored-session-services");
    const storedSession = storedHandle.session;
    sessions.push(storedSession);
    assert.ok("modelRuntime" in storedSession);
    assert.ok(storedSession.modelRuntime instanceof ModelRuntime);
    assert.equal(storedSession.modelRuntime.getProviderAuthStatus("stored-only").source, "runtime");
    assert.equal((await storedSession.modelRuntime.getAuth(storedModel))?.auth.apiKey, "stored-only-key");

    await assert.rejects(
      () => openSession(oauthModel, "oauth-session-services"),
      /cannot inherit OAuth credentials for "openai-codex" from a host-only credential store/,
    );
  } finally {
    for (const session of sessions) session.dispose();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    await rm(root, { recursive: true, force: true });
  }
});
