import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  defineTool,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionServicesOptions,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { prepareAgentSkillResources } from "./agent-skills.ts";
import type {
  AgentExecutionOptions,
  AgentProgress,
  AgentRunnerSession,
  RunContext,
} from "./agent-runner-types.ts";
import { raceWithAbort, throwIfAborted } from "./cancellation.ts";
import {
  MAX_SCHEMA_REPAIR_ATTEMPTS,
  WorkflowStructuredOutputError,
} from "./structured-output.ts";
import { providerErrorFromMessages } from "./agent-retry.ts";
import { synchronizeWorkflowModelRuntime } from "./agent-session-providers.ts";
import { hostToolProxy, isMcpToolName, WorkflowHostToolUnavailableError, type HostToolBridge } from "./host-tools.ts";
import { matchesAgentToolHint, WorkflowToolHintUnavailableError } from "./tool-capabilities.ts";
import { parseAgentModelRef } from "./model-ref.ts";
import { truncateText } from "./text.ts";
import { WORKFLOW_TOOL_NAME, type AgentToolHint } from "./types.ts";

export const FINAL_TOOL = "final_answer";
/** pi's codemode tool; SDK sessions only have it when their resource loader registers the extension. */
export const CODEMODE_TOOL = "codemode";

const SCHEMA_REPROMPT =
  `You ended your turn without calling the ${FINAL_TOOL} tool, so no result was recorded. ` +
  `Call ${FINAL_TOOL} now with your final answer as its arguments. Do not reply with plain text.`;
const DEFAULT_SEARCH_BASE_TOOLS = ["read", "bash", "grep", "find", "ls"];
const RETRY_REASON_CHARS = 160;
const RETRY_DISABLED_WARNING =
  "pi auto-retry is disabled (retry.enabled: false in pi settings), so subagents will not retry failed provider turns. " +
  "pi-workflow-engine 0.12.0 and 0.13.0 wrote that setting into ~/.pi/agent/settings.json; remove it unless you disabled retry on purpose.";
/** Runs (keyed by their shared progress sink) already warned about disabled pi auto-retry. */
const retryDisabledWarnedRuns = new WeakSet<AgentProgress>();

export interface AgentSessionHandle {
  readonly session: AgentRunnerSession;
  readonly selectedSkills: readonly Skill[];
  hasStructuredResult(): boolean;
  structuredResult(): unknown;
}

/** Resolve an explicit `agent({ model })` ref; unknown refs fail instead of falling back to another model. */
export function resolveAgentModel(modelRef: string, modelRegistry: Pick<ModelRegistry, "find">): Model<Api> {
  const parsed = parseAgentModelRef(modelRef);
  const found = modelRegistry.find(parsed.provider, parsed.id);
  if (!found) {
    throw new Error(`Agent model "${modelRef}" not found (resolved as ${parsed.provider}/${parsed.id}).`);
  }
  return found;
}

export async function openAgentSession(input: {
  readonly rc: RunContext;
  readonly prompt: string;
  readonly opts: AgentExecutionOptions;
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
  readonly label: string;
}): Promise<AgentSessionHandle> {
  const { rc, prompt, opts, cwd, model, label } = input;
  let captured = false;
  let structuredResult: unknown;
  const customTools: ToolDefinition[] = opts.schema
    ? [
        defineTool({
          name: FINAL_TOOL,
          label: "Final Answer",
          description:
            "Return your final structured answer. This MUST be your last action — do not write a normal reply after calling it.",
          parameters: opts.schema,
          // The agent's own terminal action: a codemode script must not answer on its behalf.
          exposure: "model-only",
          async execute(_toolCallId, params) {
            captured = true;
            structuredResult = params;
            return { content: [{ type: "text", text: "Recorded." }], details: params, terminate: true };
          },
        }),
      ]
    : [];
  customTools.push(...requestedHostTools(opts, rc.hostTools));
  let session: AgentRunnerSession | undefined;
  try {
    throwIfAborted(rc.signal);
    const resources = await rc.perf.time(
      "agent.session_resources_ms",
      () => prepareAgentSessionResources({ rc, prompt, opts, cwd, model, customTools, label }),
    );
    const toolSelection = buildToolSelection(opts, resources.selectedSkills.length > 0);
    session = (
      await rc.perf.time(
        "agent.create_session_ms",
        () => resources.createSession(toolSelection.sessionOptions),
      )
    ).session;
    const matchedToolHints = toolSelection.toolHints.length === 0
      ? new Set<AgentToolHint>()
      : applyDynamicToolHints(session, toolSelection);
    // A nested run would get its own concurrency cap and budget, so subagents may start one only when allowlisted.
    if (!opts.tools?.includes(WORKFLOW_TOOL_NAME)) withholdWorkflowTool(session);
    if (opts.requireToolHints) {
      const missing = toolSelection.toolHints.filter((hint) => !matchedToolHints.has(hint));
      if (missing.length > 0) throw new WorkflowToolHintUnavailableError(missing, { hostToolsReachable: rc.hostTools !== undefined });
    }
    throwIfAborted(rc.signal);
    return {
      session,
      selectedSkills: resources.selectedSkills,
      hasStructuredResult: () => captured,
      structuredResult: () => structuredResult,
    };
  } catch (error) {
    const created = session;
    if (created) rc.perf.timeSync("agent.dispose_ms", () => created.dispose());
    throw error;
  }
}

export async function promptAgentSession(input: {
  readonly rc: RunContext;
  readonly handle: AgentSessionHandle;
  readonly prompt: string;
  readonly opts: AgentExecutionOptions;
  readonly label: string;
  readonly rowId: number;
  readonly phase: string;
}): Promise<unknown> {
  const { rc, handle, prompt, opts, label, rowId, phase } = input;
  const { session } = handle;
  throwIfAborted(rc.signal);
  // pi drops a retried turn's failed message from session.messages; keep it so usage covers every attempt.
  const retriedFailures: AssistantMessage[] = [];
  let lastFailure: AssistantMessage | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName !== FINAL_TOOL) {
      rc.progress.agentTool(rowId, event.toolName);
    } else if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
      lastFailure = event.message;
    } else if (event.type === "auto_retry_start") {
      if (lastFailure) retriedFailures.push(lastFailure);
      lastFailure = undefined;
      const reason = truncateText(event.errorMessage, RETRY_REASON_CHARS);
      rc.progress.log(
        `${label}: transient provider failure (${reason}); retrying turn ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`,
      );
      rc.perf.counter("agent.turn_retry");
    }
  });
  const unlinkPromptAbort = linkSessionAbort(rc.signal, session);
  const promptSession = async (text: string) => {
    await rc.perf.time("agent.prompt_ms", () => raceWithAbort(() => session.prompt(text), rc.signal));
    const failure = providerErrorFromMessages(session.messages, {
      pauseOnUsageLimit: rc.pauseOnProviderUsageLimit,
    });
    if (failure) throw failure;
  };

  try {
    await promptSession(
      opts.schema ? `${prompt}\n\nWhen finished, return your result by calling the ${FINAL_TOOL} tool.` : prompt,
    );
    if (opts.schema && !handle.hasStructuredResult()) {
      const activeTools = session.getActiveToolNames();
      for (let attempt = 0; !handle.hasStructuredResult() && attempt < MAX_SCHEMA_REPAIR_ATTEMPTS; attempt++) {
        throwIfAborted(rc.signal);
        session.setActiveToolsByName([FINAL_TOOL]);
        rc.progress.log(`${label}: no final answer; re-prompting (${attempt + 1}/${MAX_SCHEMA_REPAIR_ATTEMPTS})`);
        rc.perf.counter("agent.structured_reprompt");
        await promptSession(SCHEMA_REPROMPT);
      }
      // Narrowing also rebuilds pi's system prompt; restore both so replay validation sees the captured identity.
      session.setActiveToolsByName(activeTools);
    }

    throwIfAborted(rc.signal);
    return rc.perf.timeSync(
      "agent.extract_result_ms",
      () => {
        if (!opts.schema) {
          return session.getLastAssistantText() ?? "";
        }
        if (!handle.hasStructuredResult()) {
          rc.progress.log(`${label}: no structured answer returned`);
          rc.perf.counter("agent.structured_missing");
          throw new WorkflowStructuredOutputError(label, MAX_SCHEMA_REPAIR_ATTEMPTS);
        }
        return handle.structuredResult();
      },
    );
  } finally {
    // Detach first: recording publishes usage to the UI and must not be able to skip listener cleanup.
    unlinkPromptAbort();
    unsubscribe();
    rc.usage.recordAgentSession({ label, phase, messages: [...retriedFailures, ...session.messages] });
  }
}


interface AgentSessionResources {
  readonly selectedSkills: readonly Skill[];
  createSession(sessionOptions: ToolSessionOptions): Promise<{ session: AgentRunnerSession }>;
}

async function prepareAgentSessionResources(input: {
  readonly rc: RunContext;
  readonly prompt: string;
  readonly opts: AgentExecutionOptions;
  readonly cwd: string;
  readonly model: Model<Api> | undefined;
  readonly customTools: ToolDefinition[];
  readonly label: string;
}): Promise<AgentSessionResources> {
  const { rc, prompt, opts, cwd, model, customTools, label } = input;
  const commonSessionOptions = (sessionOptions: ToolSessionOptions) => ({
    model,
    thinkingLevel: opts.thinkingLevel,
    noTools: sessionOptions.noTools,
    tools: sessionOptions.tools,
    customTools,
    sessionManager: SessionManager.inMemory(cwd),
  });
  const createSession = rc.createSession;
  if (createSession) {
    return {
      selectedSkills: [],
      createSession: (sessionOptions) =>
        createSession({
          cwd,
          ...commonSessionOptions(sessionOptions),
        }),
    };
  }

  const skillOptions = {
    prompt,
    skills: opts.skills,
    log: (message: string) => rc.progress.log(`${label}: ${message}`),
  };
  const preparedSkills = prepareAgentSkillResources(skillOptions);
  const services = await createAgentSessionServices({
    cwd,
    resourceLoaderOptions: { ...preparedSkills.resourceLoaderOptions, ...codemodeExtension(opts) },
  });
  await synchronizeWorkflowModelRuntime({
    host: rc.modelRegistry,
    child: services.modelRuntime,
    selectedModel: model,
    // Shared-cwd sessions mirror live removals; isolated cwd sessions retain target-only providers.
    removeChildOnlyProviders: cwd === rc.cwd,
  });
  for (const diagnostic of services.diagnostics) {
    rc.progress.log(`${label}: session ${diagnostic.type}: ${diagnostic.message}`);
  }
  if (!services.settingsManager.getRetryEnabled() && !retryDisabledWarnedRuns.has(rc.progress)) {
    retryDisabledWarnedRuns.add(rc.progress);
    rc.progress.log(RETRY_DISABLED_WARNING);
  }
  const selectedSkills = preparedSkills.resolve(services.resourceLoader);
  return {
    selectedSkills,
    createSession: (sessionOptions) =>
      createAgentSessionFromServices({
        services,
        ...commonSessionOptions(sessionOptions),
      }),
  };
}

/**
 * SDK sessions load none of pi's built-in extensions, so codemode is registered only for agents whose
 * allowlist names it. Scripts can call just the agent's other allowed tools. Mode "on" keeps those
 * tools declared whatever the user's `codemode.mode`, so the author's allowlist stays what the model sees.
 */
function codemodeExtension(opts: AgentExecutionOptions): Pick<SessionResourceLoaderOptions, "extensionFactories"> {
  if (!opts.tools?.includes(CODEMODE_TOOL)) return {};
  return { extensionFactories: [{ name: CODEMODE_TOOL, factory: createCodemodeExtension({ mode: "on" }), replaceable: true }] };
}

type SessionResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/**
 * Proxies for the host MCP tools this agent asked for: those named in its allowlist, and open-world
 * research tools when it hints `external-search`. Local `search` hints never bridge, because host tools
 * run in the host session's working directory, not the agent's (an isolated worktree, for example).
 * A named tool the run cannot reach fails the agent, like `requireToolHints`, rather than letting it
 * work without a tool its prompt may rely on.
 */
function requestedHostTools(opts: AgentExecutionOptions, bridge: HostToolBridge | undefined): ToolDefinition[] {
  const named = new Set((opts.tools ?? []).filter(isMcpToolName));
  const externalSearch = opts.toolHints?.includes("external-search") ?? false;
  if (named.size === 0 && !externalSearch) return [];
  const available = bridge?.tools() ?? [];
  const selected = available.filter((tool) => named.has(tool.name) || (externalSearch && matchesAgentToolHint(tool, "external-search")));
  const missing = [...named].filter((name) => !selected.some((tool) => tool.name === name));
  if (missing.length > 0) throw new WorkflowHostToolUnavailableError(missing, bridge !== undefined);
  return bridge ? selected.map((tool) => hostToolProxy(tool, bridge)) : [];
}

function linkSessionAbort(signal: AbortSignal | undefined, session: AgentRunnerSession): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    void session.abort().catch(() => undefined);
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

type ToolSessionOptions = Pick<CreateAgentSessionOptions, "tools" | "noTools">;

interface ToolSelection {
  readonly sessionOptions: ToolSessionOptions;
  readonly activeTools?: readonly string[];
  readonly toolHints: NonNullable<AgentExecutionOptions["toolHints"]>;
}

function buildToolSelection(opts: AgentExecutionOptions, skillsEnabled: boolean): ToolSelection {
  const toolHints = opts.toolHints ?? [];
  const fallback = toolHints.includes("search")
    ? DEFAULT_SEARCH_BASE_TOOLS
    : toolHints.includes("external-search")
      ? ["read"]
      : undefined;
  const activeTools = buildToolList(opts, skillsEnabled, fallback);
  return {
    sessionOptions: toolHints.length === 0 ? { tools: activeTools } : { noTools: "builtin" },
    activeTools,
    toolHints,
  };
}

function buildToolList(
  opts: AgentExecutionOptions,
  skillsEnabled: boolean,
  fallback?: readonly string[],
): string[] | undefined {
  const configured = opts.tools ?? fallback;
  const allow = configured ? [...configured] : undefined;
  if (!allow) return undefined;
  if (skillsEnabled && !allow.includes("read")) allow.push("read");
  if (opts.schema && !allow.includes(FINAL_TOOL)) allow.push(FINAL_TOOL);
  return allow;
}

function withholdWorkflowTool(session: AgentRunnerSession): void {
  const active = session.getActiveToolNames();
  if (active.includes(WORKFLOW_TOOL_NAME)) session.setActiveToolsByName(active.filter((name) => name !== WORKFLOW_TOOL_NAME));
}

function applyDynamicToolHints(
  session: AgentRunnerSession,
  selection: ToolSelection,
): ReadonlySet<AgentToolHint> {
  const active = new Set(selection.activeTools);
  const matched = new Set<AgentToolHint>();
  for (const tool of session.getAllTools()) {
    for (const hint of selection.toolHints) {
      if (!matchesAgentToolHint(tool, hint)) continue;
      matched.add(hint);
      active.add(tool.name);
    }
  }
  session.setActiveToolsByName([...active]);
  return matched;
}
