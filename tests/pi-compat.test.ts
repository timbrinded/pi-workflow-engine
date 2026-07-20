import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import {
  createAgentSessionServices,
  ModelRegistry,
  ModelRuntime,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import {
  assertSupportedPiVersion,
  MINIMUM_PI_VERSION,
} from "../.pi/extensions/pi-workflow-engine/src/pi-compat.ts";
import { createWorkflowModelRuntimeAccessor } from "../.pi/extensions/pi-workflow-engine/src/workflow-model-runtime.ts";

test("extension enforces the Pi SDK version required by its built-ins", () => {
  assert.equal(MINIMUM_PI_VERSION, "0.80.10");
  assert.doesNotThrow(() => assertSupportedPiVersion(VERSION));
  assert.doesNotThrow(() => assertSupportedPiVersion("0.80.10"));
  assert.doesNotThrow(() => assertSupportedPiVersion("v0.81.0-beta.1"));
  assert.throws(() => assertSupportedPiVersion("0.80.9"), /requires pi 0\.80\.10 or newer; detected "0\.80\.9"/);
  assert.throws(() => assertSupportedPiVersion("development"), /Update pi before loading this extension/);
});

test("installation docs state the minimum host Pi version", async () => {
  const [readme, usage] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("USAGE.md", "utf8"),
  ]);
  assert.match(readme, /Requires \*\*pi 0\.80\.10 or newer\*\*/);
  assert.match(usage, /requires \*\*pi 0\.80\.10 or newer\*\*/i);
});

test("late host-only provider registrations reach fresh child session services", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-workflow-runtime-compat-"));
  const runtimeOptions = {
    authPath: join(cwd, "missing-auth.json"),
    modelsPath: null,
    allowModelNetwork: false,
  } as const;
  try {
    const hostRegistry = new ModelRegistry(await ModelRuntime.create(runtimeOptions));
    const providerConfig: Parameters<ModelRegistry["registerProvider"]>[1] = {
      name: "Host-only provider",
      baseUrl: "https://host-only.invalid/v1",
      api: "openai-completions",
      authHeader: false,
      models: [
        {
          id: "host-model",
          name: "Host model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
    };
    const childRuntime = await ModelRuntime.create(runtimeOptions);
    const getModelRuntime = createWorkflowModelRuntimeAccessor(hostRegistry, childRuntime);
    assert.equal(await getModelRuntime(), childRuntime);
    assert.equal(childRuntime.getRegisteredProviderConfig("host-only"), undefined);

    hostRegistry.registerProvider("host-only", providerConfig);
    const [inheritedRuntime, concurrentRuntime] = await Promise.all([getModelRuntime(), getModelRuntime()]);
    assert.equal(concurrentRuntime, childRuntime);
    const firstInheritedConfig = childRuntime.getRegisteredProviderConfig("host-only");
    assert.ok(firstInheritedConfig);
    assert.equal(await getModelRuntime(), childRuntime);
    assert.equal(childRuntime.getRegisteredProviderConfig("host-only"), firstInheritedConfig);

    const serviceOptions = {
      cwd,
      modelRuntime: inheritedRuntime,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      },
    } as const;
    const first = await createAgentSessionServices(serviceOptions);
    const second = await createAgentSessionServices(serviceOptions);

    assert.equal(first.modelRuntime, childRuntime);
    assert.equal(second.modelRuntime, childRuntime);
    assert.notEqual(first.resourceLoader, second.resourceLoader);
    assert.notEqual(first.resourceLoader.getExtensions().runtime, second.resourceLoader.getExtensions().runtime);
    assert.deepEqual(childRuntime.getRegisteredProviderConfig("host-only"), providerConfig);
    assert.equal(childRuntime.getModel("host-only", "host-model")?.name, "Host model");

    hostRegistry.unregisterProvider("host-only");
    await getModelRuntime();
    assert.equal(childRuntime.getRegisteredProviderConfig("host-only"), undefined);

    childRuntime.registerProvider("shared-provider", { ...providerConfig, name: "Child-owned provider" });
    hostRegistry.registerProvider("shared-provider", providerConfig);
    await getModelRuntime();
    hostRegistry.unregisterProvider("shared-provider");
    await getModelRuntime();
    assert.ok(childRuntime.getRegisteredProviderConfig("shared-provider"));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
