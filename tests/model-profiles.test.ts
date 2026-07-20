import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  clearWorkflowModelProfile,
  hostWorkflowModelProfiles,
  readWorkflowModelProfileFile,
  resolveAgentModelProfile,
  resolveWorkflowModelProfiles,
  setWorkflowModelProfile,
  type ResolvedWorkflowModelProfiles,
  type WorkflowModelProfilePaths,
} from "../.pi/extensions/pi-workflow-engine/src/model-profiles.ts";
import {
  parseWorkflowModelsCommand,
  workflowModelProfileArgumentCompletions,
} from "../.pi/extensions/pi-workflow-engine/src/model-profile-command.ts";
import type { CreateAgentSession } from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import {
  createRegistry,
  createRunContext,
  createTextSession,
  runAgent,
  testModel,
} from "./agent-runner-fixtures.ts";

const TEST_ROOT = mkdtempSync(join(tmpdir(), "pi-workflow-model-profiles-"));
process.once("exit", () => rmSync(TEST_ROOT, { recursive: true, force: true }));

function profilePaths(name: string): WorkflowModelProfilePaths {
  return {
    user: join(TEST_ROOT, name, "user", "workflow-models.json"),
    project: join(TEST_ROOT, name, "project", ".pi", "workflow-models.json"),
  };
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("workflow model profiles fall back to the host model with bounded efforts", () => {
  const host = testModel("anthropic", "host");
  const profiles = resolveWorkflowModelProfiles({
    cwd: TEST_ROOT,
    modelRegistry: createRegistry([]),
    hostModel: host,
    paths: profilePaths("host-fallback"),
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [
      name,
      { model: profile.model, thinkingLevel: profile.thinkingLevel, source: profile.source },
    ])),
    {
      small: { model: host, thinkingLevel: "low", source: "host" },
      medium: { model: host, thinkingLevel: "medium", source: "host" },
      big: { model: host, thinkingLevel: "high", source: "host" },
    },
  );
});

test("project workflow model profiles override user profiles one profile at a time", () => {
  const paths = profilePaths("precedence");
  const userSmall = testModel("openai", "gpt-small");
  const userMedium = testModel("anthropic", "claude-medium");
  const projectSmall = testModel("openrouter", "anthropic/claude-fast");
  writeConfig(paths.user, {
    profiles: {
      small: { model: "openai/gpt-small", thinkingLevel: "minimal" },
      medium: { model: "anthropic/claude-medium", thinkingLevel: "medium" },
    },
  });
  writeConfig(paths.project, {
    profiles: { small: { model: "openrouter/anthropic/claude-fast", thinkingLevel: "low" } },
  });

  const profiles = resolveWorkflowModelProfiles({
    cwd: TEST_ROOT,
    modelRegistry: createRegistry([userSmall, userMedium, projectSmall]),
    hostModel: undefined,
    paths,
  });

  assert.deepEqual(profiles.small, {
    name: "small",
    model: projectSmall,
    thinkingLevel: "low",
    source: "project",
    configPath: paths.project,
  });
  assert.deepEqual(profiles.medium, {
    name: "medium",
    model: userMedium,
    thinkingLevel: "medium",
    source: "user",
    configPath: paths.user,
  });
  assert.equal(profiles.big.source, "host");
});

test("workflow model profile config rejects malformed, secret-bearing, and ambiguous entries", () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly contents: string; readonly pattern: RegExp }> = [
    { name: "json", contents: "{", pattern: /Invalid JSON in workflow model profiles/ },
    { name: "root", contents: "[]", pattern: /root must be an object/ },
    { name: "missing-profiles", contents: "{}", pattern: /"profiles" must be an object/ },
    { name: "unknown-root", contents: '{"token":"secret"}', pattern: /unexpected key "token"/ },
    { name: "unknown-profile", contents: '{"profiles":{"huge":{"model":"openai/gpt"}}}', pattern: /unknown profile "huge"/ },
    { name: "missing-model", contents: '{"profiles":{"small":{"thinkingLevel":"low"}}}', pattern: /requires a provider-qualified "model"/ },
    { name: "bare-model", contents: '{"profiles":{"small":{"model":"gpt"}}}', pattern: /exact provider\/model identity/ },
    { name: "double-slash", contents: '{"profiles":{"small":{"model":"openai\/\/gpt"}}}', pattern: /exact provider\/model identity/ },
    { name: "thinking", contents: '{"profiles":{"small":{"model":"openai\/gpt","thinkingLevel":"huge"}}}', pattern: /thinkingLevel must be/ },
    { name: "secret", contents: '{"profiles":{"small":{"model":"openai\/gpt","apiKey":"secret"}}}', pattern: /unexpected key "apiKey"/ },
  ];

  for (const entry of cases) {
    const path = join(TEST_ROOT, "malformed", entry.name, "workflow-models.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, entry.contents, "utf8");
    assert.throws(
      () => resolveWorkflowModelProfiles({
        cwd: TEST_ROOT,
        modelRegistry: createRegistry([]),
        hostModel: undefined,
        paths: { user: path, project: `${path}.project` },
      }),
      entry.pattern,
      entry.name,
    );
  }
});

test("configured profiles reject models that are not available in the host registry", () => {
  const paths = profilePaths("missing-model");
  writeConfig(paths.user, { profiles: { small: { model: "openai/missing" } } });

  assert.throws(
    () => resolveWorkflowModelProfiles({
      cwd: TEST_ROOT,
      modelRegistry: createRegistry([]),
      hostModel: undefined,
      paths,
    }),
    /references unavailable model "openai\/missing".*\/workflow:models set small provider\/model/,
  );
});

test("set and clear update one exact profile without copying arbitrary config fields", () => {
  const paths = profilePaths("write");
  const small = testModel("openai", "small");
  const medium = testModel("anthropic", "medium");
  const registry = createRegistry([small, medium]);

  setWorkflowModelProfile({
    configPath: paths.user,
    name: "small",
    profile: { model: "openai/small", thinkingLevel: "low" },
    modelRegistry: registry,
  });
  setWorkflowModelProfile({
    configPath: paths.user,
    name: "medium",
    profile: { model: "anthropic/medium" },
    modelRegistry: registry,
  });
  clearWorkflowModelProfile(paths.user, "small");

  assert.deepEqual(readWorkflowModelProfileFile(paths.user), {
    profiles: { medium: { model: "anthropic/medium" } },
  });
  assert.doesNotMatch(readFileSync(paths.user, "utf8"), /apiKey|token|secret/i);
});

test("agent routing applies explicit fields before profile fields and host inheritance", () => {
  const host = testModel("anthropic", "host");
  const profiled = testModel("openai", "profiled");
  const explicit = testModel("openrouter", "explicit");
  const profiles: ResolvedWorkflowModelProfiles = {
    ...hostWorkflowModelProfiles(host),
    medium: { name: "medium", model: profiled, thinkingLevel: "high", source: "user", configPath: "user.json" },
  };
  const resolveExplicit = (ref: string): Model<Api> | undefined => ref === "openrouter/explicit" ? explicit : undefined;

  assert.deepEqual(
    resolveAgentModelProfile({ request: { profile: "medium" }, profiles, resolveExplicitModel: resolveExplicit, hostModel: host }),
    { model: profiled, thinkingLevel: "high" },
  );
  assert.deepEqual(
    resolveAgentModelProfile({
      request: { profile: "medium", model: "openrouter/explicit", thinkingLevel: "minimal" },
      profiles,
      resolveExplicitModel: resolveExplicit,
      hostModel: host,
    }),
    { model: explicit, thinkingLevel: "minimal" },
  );
  assert.deepEqual(
    resolveAgentModelProfile({ request: {}, profiles, resolveExplicitModel: resolveExplicit, hostModel: host }),
    { model: host, thinkingLevel: undefined },
  );
});

test("runAgent sends the selected profile model and effort into the pi session", async () => {
  const host = testModel("anthropic", "host");
  const profiled = testModel("openai", "profiled");
  const profiles: ResolvedWorkflowModelProfiles = {
    ...hostWorkflowModelProfiles(host),
    small: { name: "small", model: profiled, thinkingLevel: "minimal", source: "project", configPath: "project.json" },
  };
  let observedModel: Model<Api> | undefined;
  let observedThinking: ThinkingLevel | undefined;
  const createSession: CreateAgentSession = async (options) => {
    observedModel = options.model;
    observedThinking = options.thinkingLevel;
    return createTextSession();
  };

  const result = await runAgent(
    createRunContext({ createSession, hostModel: host, modelRegistry: createRegistry([profiled]), modelProfiles: profiles }),
    "profile me",
    { profile: "small", label: "profiled" },
  );

  assert.equal(result, "done");
  assert.equal(observedModel, profiled);
  assert.equal(observedThinking, "minimal");
});

test("/workflow:models parser keeps scope and profile configuration explicit", () => {
  assert.deepEqual(parseWorkflowModelsCommand(""), { kind: "status" });
  assert.deepEqual(parseWorkflowModelsCommand("status"), { kind: "status" });
  assert.deepEqual(parseWorkflowModelsCommand("set small openai/gpt low"), {
    kind: "set",
    scope: "user",
    profile: "small",
    model: "openai/gpt",
    thinkingLevel: "low",
  });
  assert.deepEqual(parseWorkflowModelsCommand("set big anthropic/claude --project"), {
    kind: "set",
    scope: "project",
    profile: "big",
    model: "anthropic/claude",
  });
  assert.deepEqual(parseWorkflowModelsCommand("clear medium --user"), {
    kind: "clear",
    scope: "user",
    profile: "medium",
  });
  assert.equal(parseWorkflowModelsCommand("set small openai/gpt --user --project").kind, "error");
  assert.equal(parseWorkflowModelsCommand("set huge openai/gpt").kind, "error");
  assert.equal(parseWorkflowModelsCommand("set small openai/gpt enormous").kind, "error");
  assert.equal(parseWorkflowModelsCommand("clear small extra").kind, "error");
});

test("/workflow:models exposes native completions without filling the free-form model slot", () => {
  assert.deepEqual(
    workflowModelProfileArgumentCompletions("s")?.map((item) => item.value),
    ["status", "set"],
  );
  assert.deepEqual(
    workflowModelProfileArgumentCompletions("set m")?.map((item) => item.value),
    ["set medium"],
  );
  assert.equal(workflowModelProfileArgumentCompletions("set small "), null);
  assert.deepEqual(
    workflowModelProfileArgumentCompletions("set small openai/gpt h")?.map((item) => item.value),
    ["set small openai/gpt high"],
  );
  assert.deepEqual(
    workflowModelProfileArgumentCompletions("clear big --")?.map((item) => item.value),
    ["clear big --user", "clear big --project"],
  );
  assert.equal(workflowModelProfileArgumentCompletions("clear big --user "), null);
});
