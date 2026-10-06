import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  defineTool,
  SessionManager,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { prepareAgentSkillResources } from "./agent-skills.ts";
import type {
  AgentExecutionOptions,
  AgentProgress,
  AgentRunTags,
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
import { matchesAgentToolHint, WorkflowToolHintUnavailableError } from "./tool-capabilities.ts";
import { truncateText } from "./text.ts";
import type { AgentToolHint } from "./types.ts";

export const FINAL_TOOL = "final_answer";

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
  readonly tags: AgentRunTags;
}): Promise<AgentSessionHandle> {
  const { rc, prompt, opts, cwd, model, label, tags } = input;
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
          async execute(_toolCallId, params) {
            captured = true;
            structuredResult = params;
            return { content: [{ type: "text", text: "Recorded." }], details: params, terminate: true };
          },
        }),
      ]
    : [];
  let session: AgentRunnerSession | undefined;
  try {
    throwIfAborted(rc.signal);
    const resources = await rc.perf.time(
      "agent.session_resources_ms",
      () => prepareAgentSessionResources({ rc, prompt, opts, cwd, model, customTools, label }),
      tags,
    );
    const toolSelection = buildToolSelection(opts, resources.selectedSkills.length > 0);
    session = (
      await rc.perf.time(
        "agent.create_session_ms",
        () => resources.createSession(toolSelection.sessionOptions),
        tags,
      )
    ).session;
    const matchedToolHints = toolSelection.toolHints.length === 0
      ? new Set<AgentToolHint>()
      : applyDynamicToolHints(session, toolSelection);
    if (opts.requireToolHints) {
      const missing = toolSelection.toolHints.filter((hint) => !matchedToolHints.has(hint));
      if (missing.length > 0) throw new WorkflowToolHintUnavailableError(missing);
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
    if (created) rc.perf.timeSync("agent.dispose_ms", () => created.dispose(), tags);
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
  readonly tags: AgentRunTags;
}): Promise<unknown> {
  const { rc, handle, prompt, opts, label, rowId, tags } = input;
  const { session } = handle;
  throwIfAborted(rc.signal);
  // pi drops a retried turn's failed message from session.messages; keep it so usage covers every attempt.
  const retriedFailures: AssistantMessage[] = [];
  let lastFailure: AssistantMessage | undefined;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName !== FINAL_TOOL) {
      rc.progress.agentTool(label, event.toolName, rowId);
    } else if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "error") {
      lastFailure = event.message;
    } else if (event.type === "auto_retry_start") {
      if (lastFailure) retriedFailures.push(lastFailure);
      lastFailure = undefined;
      const reason = truncateText(event.errorMessage, RETRY_REASON_CHARS);
      rc.progress.log(
        `${label}: transient provider failure (${reason}); retrying turn ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms`,
      );
      rc.perf.counter("agent.turn_retry", 1, tags);
    }
  });
  const unlinkPromptAbort = linkSessionAbort(rc.signal, session);
  const promptSession = async (text: string) => {
    await rc.perf.time("agent.prompt_ms", () => raceWithAbort(() => session.prompt(text), rc.signal), tags);
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
        rc.perf.counter("agent.structured_reprompt", 1, tags);
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
          rc.perf.counter("agent.structured_missing", 1, tags);
          throw new WorkflowStructuredOutputError(label, MAX_SCHEMA_REPAIR_ATTEMPTS);
        }
        return handle.structuredResult();
      },
      tags,
    );
  } finally {
    // Detach first: recording publishes usage to the UI and must not be able to skip listener cleanup.
    unlinkPromptAbort();
    unsubscribe();
    rc.usage.recordAgentSession({ label, phase: tags.phase, messages: [...retriedFailures, ...session.messages] });
  }
}

function parseAgentModelRef(modelRef: string): { readonly provider: string; readonly id: string } {
  const normalized = modelRef.trim();
  if (normalized.length === 0) {
    throw new Error('Invalid agent model ref: expected a bare model id or "provider/id".');
  }
  if (normalized !== modelRef) {
    throw new Error(`Invalid agent model ref "${modelRef}": remove leading or trailing whitespace.`);
  }

  const slash = modelRef.indexOf("/");
  if (slash === -1) return { provider: "anthropic", id: modelRef };
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  if (provider.length === 0 || id.length === 0 || id.startsWith("/")) {
    throw new Error(`Invalid agent model ref "${modelRef}": expected "provider/id".`);
  }
  return { provider, id };
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
    resourceLoaderOptions: preparedSkills.resourceLoaderOptions,
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
