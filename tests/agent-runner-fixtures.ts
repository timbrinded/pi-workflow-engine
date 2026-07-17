import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  runAgent as runAgentWithContext,
  type AgentProgress,
  type CreateAgentSession,
  type RunContext,
} from "../.pi/extensions/pi-workflow-engine/src/agent-runner.ts";
import { Semaphore } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { PerfRecorder } from "../.pi/extensions/pi-workflow-engine/src/perf.ts";
import { createWorkflowUsageRecorder } from "../.pi/extensions/pi-workflow-engine/src/usage.ts";
import { createBudget, type WorkflowBudget } from "../.pi/extensions/pi-workflow-engine/src/budget.ts";
import {
  createMemoryBackedJournal,
  type WorkflowJournal,
} from "../.pi/extensions/pi-workflow-engine/src/journal.ts";
import {
  WorktreeRegistry,
  type WorktreeGitCommandOptions,
  type WorktreeGitRunner,
} from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import type { AgentResumeBaseContext } from "../.pi/extensions/pi-workflow-engine/src/resume-context.ts";

export type FindCall = { readonly provider: string; readonly modelId: string };

export const TEST_CWD = mkdtempSync(join(tmpdir(), "pi-agent-runner-"));
process.once("exit", () => {
  rmSync(TEST_CWD, { recursive: true, force: true });
});

export const RESUME_BASE_CONTEXT: AgentResumeBaseContext = {
  workflow: { kind: "verified", name: "model-resume-test", sourceFingerprint: "source-a" },
};

export function runAgent(
  rc: RunContext,
  prompt: string,
  opts: Parameters<typeof runAgentWithContext>[2] = {},
  resumeBaseContext: AgentResumeBaseContext = RESUME_BASE_CONTEXT,
): Promise<unknown> {
  return runAgentWithContext(rc, prompt, opts, resumeBaseContext);
}

export function testModel(provider: string, id: string): Model<Api> {
  return {
    id,
    name: `${provider}/${id}`,
    api: "anthropic-messages",
    provider,
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

export function createRegistry(models: readonly Model<Api>[], calls: FindCall[] = []): Pick<ModelRegistry, "find"> {
  return {
    find(provider, modelId) {
      calls.push({ provider, modelId });
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
  };
}

export function createProgress(): AgentProgress & { readonly events: string[] } {
  const events: string[] = [];
  return {
    events,
    agentQueued(_phase, label) {
      events.push(`queued:${label}`);
      return events.length;
    },
    agentStart(_phase, label) {
      events.push(`start:${label}`);
    },
    agentTool(label, tool) {
      events.push(`tool:${label}:${tool}`);
    },
    agentDone(label) {
      events.push(`done:${label}`);
    },
    agentFailed(label, error) {
      events.push(`failed:${label}:${String(error)}`);
    },
    log(message) {
      events.push(`log:${message}`);
    },
  };
}

export function createRunContext(input: {
  readonly createSession: CreateAgentSession;
  readonly hostModel?: Model<Api>;
  readonly modelRegistry?: Pick<ModelRegistry, "find">;
  readonly progress?: AgentProgress;
  readonly cwd?: string;
  readonly budget?: WorkflowBudget;
  readonly usage?: ReturnType<typeof createWorkflowUsageRecorder>;
  readonly journal?: WorkflowJournal;
  readonly worktrees?: WorktreeRegistry;
}): RunContext {
  const usage = input.usage ?? createWorkflowUsageRecorder();
  const cwd = input.cwd ?? TEST_CWD;
  return {
    cwd,
    hostModel: input.hostModel,
    modelRegistry: input.modelRegistry ?? createRegistry([]),
    semaphore: new Semaphore(1),
    progress: input.progress ?? createProgress(),
    signal: undefined,
    perf: new PerfRecorder(),
    usage,
    budget: input.budget ?? createBudget(null, usage),
    journal: input.journal ?? createMemoryBackedJournal(),
    worktrees: input.worktrees ?? new WorktreeRegistry(cwd),
    createSession: input.createSession,
  };
}

export const DEFAULT_SESSION_MODEL = testModel("test", "default-session-model");

export function createTextSession(model: Model<Api> | undefined = DEFAULT_SESSION_MODEL): Awaited<ReturnType<CreateAgentSession>> {
  return {
    session: {
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        systemPrompt: "Test system prompt",
        model,
        thinkingLevel: "low",
      },
      async prompt() {},
      subscribe() {
        return () => {};
      },
      dispose() {},
      async abort() {},
      getAllTools() {
        return [TEST_TOOL];
      },
      getActiveToolNames() {
        return [TEST_TOOL.name];
      },
      getToolDefinition(name) {
        return name === TEST_TOOL.name ? TEST_TOOL_DEFINITION : undefined;
      },
    },
  };
}

export const TEST_TOOL = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: {} },
  promptGuidelines: [],
  sourceInfo: { path: "builtin:read", source: "builtin", scope: "temporary", origin: "top-level" },
} as const;

export const TEST_TOOL_DEFINITION = {
  name: TEST_TOOL.name,
  description: TEST_TOOL.description,
  parameters: TEST_TOOL.parameters,
  async execute() {
    return { content: [], details: undefined };
  },
} as const;

export function createFakeWorktreeRegistry(input: {
  readonly repoCwd: string;
  readonly insideGit?: boolean;
  readonly patch?: string;
  readonly changed?: boolean;
  readonly removeResult?: { readonly ok: boolean; readonly stdout: string; readonly stderr: string; readonly error?: string };
}): { readonly registry: WorktreeRegistry; readonly calls: WorktreeGitCommandOptions[] } {
  const calls: WorktreeGitCommandOptions[] = [];
  const runner: WorktreeGitRunner = {
    async runGit(options) {
      calls.push(options);
      const command = options.args.join(" ");
      if (command === "rev-parse --is-inside-work-tree") {
        return { ok: true, stdout: input.insideGit === false ? "false\n" : "true\n", stderr: "" };
      }
      if (command === "rev-parse --verify HEAD^{commit}") {
        return { ok: true, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      }
      if (options.args[0] === "worktree" && options.args[1] === "add") return { ok: true, stdout: "", stderr: "" };
      if (options.args[0] === "worktree" && options.args[1] === "remove") return input.removeResult ?? { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    },
  };
  return {
    calls,
    registry: new WorktreeRegistry(input.repoCwd, {
      runner,
      patchCapture: async () => ({ patch: input.patch ?? "", changed: input.changed ?? false }),
    }),
  };
}

export function commandNames(calls: readonly WorktreeGitCommandOptions[]): string[] {
  return calls.map((call) => call.args.slice(0, 2).join(" "));
}

export async function writeProjectSkill(cwd: string, name: string): Promise<void> {
  const dir = join(cwd, ".pi", "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill for workflow subagent skill filtering.\n---\n\n# ${name}\n`,
    "utf8",
  );
}
