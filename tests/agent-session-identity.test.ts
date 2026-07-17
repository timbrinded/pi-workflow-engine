import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { test } from "bun:test";
import {
  captureEffectiveAgentSessionIdentity,
  type EffectiveAgentSessionIdentity,
  type EffectiveAgentSessionIdentityCapture,
  type EffectiveAgentSessionLike,
  type EffectiveToolDefinitionLike,
  type EffectiveToolInfoLike,
} from "../.pi/extensions/pi-workflow-engine/src/agent-session-identity.ts";

const MODEL = { provider: "test-provider", id: "test-model" } as const;
const PARAMETERS = { type: "object", properties: { path: { type: "string" } } } as const;

async function executeRead(): Promise<{ content: readonly [] }> {
  return { content: [] };
}

async function executeBash(): Promise<{ content: readonly [] }> {
  return { content: [] };
}

function syntheticTool(
  name: string,
  execute: unknown,
  parameters: unknown = PARAMETERS,
): { info: EffectiveToolInfoLike; definition: EffectiveToolDefinitionLike } {
  return {
    info: {
      name,
      description: `${name} description`,
      parameters,
      promptGuidelines: [`Use ${name} carefully`],
      sourceInfo: { path: `<builtin:${name}>`, source: "builtin", scope: "temporary", origin: "top-level" },
    },
    definition: {
      name,
      description: `${name} description`,
      parameters,
      promptSnippet: `${name}: test tool`,
      promptGuidelines: [`Use ${name} carefully`],
      executionMode: "parallel",
      execute,
    },
  };
}

function fakeSession(input: {
  readonly tools: readonly { readonly info: EffectiveToolInfoLike; readonly definition?: EffectiveToolDefinitionLike }[];
  readonly activeTools?: readonly string[];
  readonly model?: { readonly provider: string; readonly id: string };
  readonly systemPrompt?: string;
  readonly thinkingLevel?: string;
}): EffectiveAgentSessionLike {
  const definitions = new Map(input.tools.flatMap((tool) => (tool.definition ? [[tool.info.name, tool.definition] as const] : [])));
  return {
    systemPrompt: input.systemPrompt ?? "You are a focused test agent.",
    model: input.model ?? MODEL,
    thinkingLevel: input.thinkingLevel ?? "high",
    getActiveToolNames: () => input.activeTools ?? input.tools.map((tool) => tool.info.name),
    getAllTools: () => input.tools.map((tool) => tool.info),
    getToolDefinition: (name) => definitions.get(name),
  };
}

function verifiedIdentity(capture: EffectiveAgentSessionIdentityCapture): EffectiveAgentSessionIdentity {
  if (capture.kind !== "verified") assert.fail(`expected verified identity: ${capture.reason}`);
  return capture.identity;
}

test("captures post-creation effective state and preserves active tool order", async () => {
  const read = syntheticTool("read", executeRead);
  const bash = syntheticTool("bash", executeBash);
  const capture = await captureEffectiveAgentSessionIdentity(
    fakeSession({ tools: [read, bash], activeTools: ["bash", "read"] }),
    { workspaceRoot: process.cwd(), sessionCwd: process.cwd() },
  );

  const identity = verifiedIdentity(capture);
  assert.equal(identity.runtimeVersion, VERSION);
  assert.deepEqual(identity.model, MODEL);
  assert.equal(identity.thinkingLevel, "high");
  assert.match(identity.systemPromptFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    identity.tools.map((tool) => tool.name),
    ["bash", "read"],
  );
  assert.match(identity.tools[0]!.definitionFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(identity.tools[0]!.implementationFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(identity.tools[0]!.source.fingerprint, /^sha256:[a-f0-9]{64}$/);
});

test("effective prompt, model, thinking, tool order, and runtime version all change the identity", async () => {
  const read = syntheticTool("read", executeRead);
  const bash = syntheticTool("bash", executeBash);
  const options = { workspaceRoot: process.cwd(), sessionCwd: process.cwd(), runtimeVersion: "test-runtime-1" } as const;
  const base = verifiedIdentity(
    await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [read, bash], activeTools: ["read", "bash"] }), options),
  );
  const captures = await Promise.all([
    captureEffectiveAgentSessionIdentity(
      fakeSession({ tools: [read, bash], activeTools: ["read", "bash"], systemPrompt: "A changed prompt" }),
      options,
    ),
    captureEffectiveAgentSessionIdentity(
      fakeSession({ tools: [read, bash], activeTools: ["read", "bash"], model: { provider: "other", id: "model" } }),
      options,
    ),
    captureEffectiveAgentSessionIdentity(
      fakeSession({ tools: [read, bash], activeTools: ["read", "bash"], thinkingLevel: "low" }),
      options,
    ),
    captureEffectiveAgentSessionIdentity(fakeSession({ tools: [read, bash], activeTools: ["bash", "read"] }), options),
    captureEffectiveAgentSessionIdentity(fakeSession({ tools: [read, bash], activeTools: ["read", "bash"] }), {
      ...options,
      runtimeVersion: "test-runtime-2",
    }),
  ]);

  for (const capture of captures) assert.notEqual(verifiedIdentity(capture).fingerprint, base.fingerprint);
});

test("normalizes identical workspace-local sources across disposable worktree roots", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "pi-agent-identity-worktree-a-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "pi-agent-identity-worktree-b-"));
  try {
    for (const root of [firstRoot, secondRoot]) {
      await writeFile(join(root, "extension.ts"), "export const extension = true;\n", "utf8");
      await writeFile(join(root, "helper.ts"), "export const value = 'same';\n", "utf8");
    }

    const identityFor = async (root: string): Promise<EffectiveAgentSessionIdentity> => {
      const tool = localTool(root);
      return verifiedIdentity(
        await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [tool], systemPrompt: `Work in ${root}/src.` }), {
          workspaceRoot: process.cwd(),
          sessionCwd: root,
          runtimeVersion: "test-runtime",
        }),
      );
    };

    const first = await identityFor(firstRoot);
    const second = await identityFor(secondRoot);
    assert.deepEqual(second, first);
    assert.equal(first.tools[0]!.source.path, "workspace:extension.ts");
    assert.equal(first.tools[0]!.source.baseDir, "workspace:.");

    await writeFile(join(secondRoot, "helper.ts"), "export const value = 'changed';\n", "utf8");
    const changed = await identityFor(secondRoot);
    assert.notEqual(changed.tools[0]!.source.fingerprint, first.tools[0]!.source.fingerprint);
    assert.notEqual(changed.fingerprint, first.fingerprint);
  } finally {
    await rm(firstRoot, { recursive: true, force: true });
    await rm(secondRoot, { recursive: true, force: true });
  }
});

test("definition and executable changes invalidate synthetic tool identity", async () => {
  const firstTool = syntheticTool("read", executeRead);
  const secondTool = syntheticTool("read", executeBash);
  const changedParameters = syntheticTool("read", executeRead, {
    type: "object",
    properties: { line: { type: "number" } },
  });
  const options = { workspaceRoot: process.cwd(), sessionCwd: process.cwd(), runtimeVersion: "test-runtime" } as const;

  const first = verifiedIdentity(await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [firstTool] }), options));
  const implementationChanged = verifiedIdentity(
    await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [secondTool] }), options),
  );
  const definitionChanged = verifiedIdentity(
    await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [changedParameters] }), options),
  );

  assert.notEqual(implementationChanged.tools[0]!.implementationFingerprint, first.tools[0]!.implementationFingerprint);
  assert.notEqual(definitionChanged.tools[0]!.definitionFingerprint, first.tools[0]!.definitionFingerprint);
});

test("fails closed for missing definitions, opaque handlers, and unresolved source files", async () => {
  const read = syntheticTool("read", executeRead);
  const missingDefinition = await captureEffectiveAgentSessionIdentity(
    fakeSession({ tools: [{ info: read.info }] }),
    { workspaceRoot: process.cwd(), sessionCwd: process.cwd(), runtimeVersion: "test-runtime" },
  );
  assert.deepEqual(missingDefinition, { kind: "unverifiable", reason: 'active tool "read" has no executable definition' });

  const opaque = syntheticTool("read", Math.max);
  const opaqueCapture = await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [opaque] }), {
    workspaceRoot: process.cwd(),
    sessionCwd: process.cwd(),
    runtimeVersion: "test-runtime",
  });
  assert.equal(opaqueCapture.kind, "unverifiable");
  if (opaqueCapture.kind === "unverifiable") assert.match(opaqueCapture.reason, /no inspectable source/);

  const missingSource = localTool(join(process.cwd(), "missing-tool-source"));
  const missingSourceCapture = await captureEffectiveAgentSessionIdentity(fakeSession({ tools: [missingSource] }), {
    workspaceRoot: process.cwd(),
    sessionCwd: process.cwd(),
    runtimeVersion: "test-runtime",
  });
  assert.equal(missingSourceCapture.kind, "unverifiable");
  if (missingSourceCapture.kind === "unverifiable") assert.match(missingSourceCapture.reason, /does not identify a regular file/);
});

function localTool(root: string): { info: EffectiveToolInfoLike; definition: EffectiveToolDefinitionLike } {
  return {
    info: {
      name: "local_tool",
      description: "Local test tool",
      parameters: PARAMETERS,
      promptGuidelines: [],
      sourceInfo: {
        path: join(root, "extension.ts"),
        source: "local",
        scope: "project",
        origin: "top-level",
        baseDir: root,
      },
    },
    definition: {
      name: "local_tool",
      description: "Local test tool",
      parameters: PARAMETERS,
      promptGuidelines: [],
      execute: executeRead,
    },
  };
}
