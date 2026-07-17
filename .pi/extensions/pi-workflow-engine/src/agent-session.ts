import type { Api, Model } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  SessionManager,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  appendSkillReminder,
  createAgentSkillResourceLoader,
  extractSkillSelectorsFromText,
} from "./agent-skills.ts";
import type {
  AgentExecutionOptions,
  AgentRunTags,
  AgentRunnerSession,
  AgentRunnerToolInfo,
  RunContext,
} from "./agent-runner-types.ts";
import {
  captureEffectiveAgentSessionIdentity,
  type EffectiveAgentSessionIdentity,
  type EffectiveToolInfoLike,
} from "./agent-session-identity.ts";
import { throwIfAborted } from "./cancellation.ts";

export const FINAL_TOOL = "final_answer";

const SCHEMA_REPROMPT_ATTEMPTS = 1;
const SCHEMA_REPROMPT =
  `You ended your turn without calling the ${FINAL_TOOL} tool, so no result was recorded. ` +
  `Call ${FINAL_TOOL} now with your final answer as its arguments. Do not reply with plain text.`;
const BUILTIN_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
const DEFAULT_SEARCH_BASE_TOOLS = ["read", "bash", "grep", "find", "ls"];

export interface ResolvedAgentModelRequest {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
}

export interface ResolvedAgentModel {
  readonly model: Model<Api> | undefined;
  readonly requested: ResolvedAgentModelRequest | undefined;
}

export interface AgentSessionHandle {
  readonly session: AgentRunnerSession;
  readonly selectedSkills: readonly Skill[];
  structuredResult(): unknown;
}

export type EffectiveSessionCapture =
  | { readonly kind: "verified"; readonly identity: EffectiveAgentSessionIdentity }
  | { readonly kind: "unverifiable"; readonly reason: string };

export function resolveAgentModel(
  modelRef: string | undefined,
  modelRegistry: Pick<ModelRegistry, "find">,
  hostModel: Model<Api> | undefined,
): ResolvedAgentModel {
  if (modelRef === undefined) return { model: hostModel, requested: undefined };

  const parsed = parseAgentModelRef(modelRef);
  const found = modelRegistry.find(parsed.provider, parsed.id);
  if (!found) {
    throw new Error(`Agent model "${modelRef}" not found (resolved as ${parsed.provider}/${parsed.id}).`);
  }
  return { model: found, requested: parsed };
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
  const skillSetup = shouldCreateSkillResourceLoader(rc, prompt, opts)
    ? await rc.perf.time(
        "agent.skills_ms",
        () =>
          createAgentSkillResourceLoader({
            cwd,
            prompt,
            skills: opts.skills,
            log: (message) => rc.progress.log(`${label}: ${message}`),
          }),
        tags,
      )
    : undefined;
  const selectedSkills = skillSetup?.selectedSkills ?? [];
  const toolSelection = buildToolSelection(opts, selectedSkills.length > 0);
  let captured: unknown = null;
  const customTools: ToolDefinition[] = opts.schema
    ? [
        defineTool({
          name: FINAL_TOOL,
          label: "Final Answer",
          description:
            "Return your final structured answer. This MUST be your last action — do not write a normal reply after calling it.",
          parameters: opts.schema,
          async execute(_toolCallId, params) {
            captured = params;
            return { content: [{ type: "text", text: "Recorded." }], details: params, terminate: true };
          },
        }),
      ]
    : [];
  const createSubagentSession = (sessionOptions: ToolSessionOptions) =>
    rc.perf.time(
      "agent.create_session_ms",
      () => {
        const options = {
          cwd,
          model,
          thinkingLevel: opts.thinkingLevel,
          tools: sessionOptions.tools,
          excludeTools: sessionOptions.excludeTools,
          customTools,
          resourceLoader: skillSetup?.resourceLoader,
          sessionManager: SessionManager.inMemory(cwd),
        };
        if (rc.createSession) {
          return rc.createSession({ ...options, modelRegistry: rc.modelRegistry });
        }
        return defaultCreateSession({ ...options, modelRegistry: rc.modelRegistry });
      },
      tags,
    );

  let session: AgentRunnerSession | undefined;
  try {
    throwIfAborted(rc.signal);
    session = (await createSubagentSession(toolSelection.sessionOptions)).session;
    const dynamicToolHintsApplied = toolSelection.toolHints.length === 0 || applyDynamicToolHints(session, toolSelection);
    if (!dynamicToolHintsApplied) {
      rc.progress.log(`${label}: dynamic tool hints unavailable; falling back to concrete tools only`);
      rc.perf.counter("agent.tool_hint_fallback", 1, tags);
      const dynamicSession = session;
      session = undefined;
      rc.perf.timeSync("agent.dispose_ms", () => dynamicSession.dispose(), tags);
      throwIfAborted(rc.signal);
      session = (await createSubagentSession(toolSelection.fallbackSessionOptions)).session;
    }
    throwIfAborted(rc.signal);
    return { session, selectedSkills, structuredResult: () => captured };
  } catch (error) {
    if (session) {
      const activeSession = session;
      session = undefined;
      rc.perf.timeSync("agent.dispose_ms", () => activeSession.dispose(), tags);
    }
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
  const { session, selectedSkills } = handle;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName !== undefined && event.toolName !== FINAL_TOOL) {
      rc.progress.agentTool(label, event.toolName, rowId);
    }
  });

  try {
    const promptedWithSkills = appendSkillReminder(prompt, selectedSkills);
    const finalPrompt = opts.schema
      ? `${promptedWithSkills}\n\nWhen finished, return your result by calling the ${FINAL_TOOL} tool.`
      : promptedWithSkills;
    throwIfAborted(rc.signal);
    const unlinkPromptAbort = linkSessionAbort(rc.signal, session);
    try {
      try {
        await rc.perf.time("agent.prompt_ms", () => session.prompt(finalPrompt), tags);
        if (opts.schema) {
          for (let attempt = 0; handle.structuredResult() === null && attempt < SCHEMA_REPROMPT_ATTEMPTS; attempt++) {
            throwIfAborted(rc.signal);
            rc.progress.log(`${label}: no final answer; re-prompting (${attempt + 1}/${SCHEMA_REPROMPT_ATTEMPTS})`);
            rc.perf.counter("agent.structured_reprompt", 1, tags);
            await rc.perf.time("agent.prompt_ms", () => session.prompt(SCHEMA_REPROMPT), tags);
          }
        }

        throwIfAborted(rc.signal);
        return rc.perf.timeSync(
          "agent.extract_result_ms",
          () => {
            if (!opts.schema) return lastAssistantText(session.state);
            const result = handle.structuredResult();
            if (result === null) {
              rc.progress.log(`${label}: no structured answer returned`);
              rc.perf.counter("agent.structured_missing", 1, tags);
            }
            return result;
          },
          tags,
        );
      } finally {
        rc.usage.recordAgentSession({ label, phase: tags.phase, messages: session.state.messages });
      }
    } finally {
      unlinkPromptAbort();
    }
  } finally {
    unsubscribe();
  }
}

export async function captureEffectiveSession(
  session: AgentRunnerSession,
  sessionCwd: string,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<EffectiveSessionCapture> {
  const state = session.state;
  if (typeof state.systemPrompt !== "string") {
    return { kind: "unverifiable", reason: "effective system prompt is unavailable" };
  }
  if (!state.model) return { kind: "unverifiable", reason: "effective model is unavailable" };
  if (typeof state.thinkingLevel !== "string") {
    return { kind: "unverifiable", reason: "effective thinking level is unavailable" };
  }
  if (!session.getActiveToolNames || !session.getAllTools || !session.getToolDefinition) {
    return { kind: "unverifiable", reason: "effective tool APIs are unavailable" };
  }
  const toolInfos = effectiveToolInfos(session.getAllTools());
  if (toolInfos.kind === "unverifiable") return toolInfos;
  return await captureEffectiveAgentSessionIdentity(
    {
      systemPrompt: state.systemPrompt,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      getActiveToolNames: () => session.getActiveToolNames!(),
      getAllTools: () => toolInfos.tools,
      getToolDefinition: (name) => session.getToolDefinition!(name),
    },
    { sessionCwd, workspaceRoot, signal },
  );
}

function parseAgentModelRef(modelRef: string): ResolvedAgentModelRequest {
  const normalized = modelRef.trim();
  if (normalized.length === 0) {
    throw new Error('Invalid agent model ref: expected a bare model id or "provider/id".');
  }
  if (normalized !== modelRef) {
    throw new Error(`Invalid agent model ref "${modelRef}": remove leading or trailing whitespace.`);
  }

  const slash = modelRef.indexOf("/");
  if (slash === -1) return { ref: modelRef, provider: "anthropic", id: modelRef };
  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  if (provider.length === 0 || id.length === 0 || id.startsWith("/")) {
    throw new Error(`Invalid agent model ref "${modelRef}": expected "provider/id".`);
  }
  return { ref: modelRef, provider, id };
}

async function defaultCreateSession(options: CreateAgentSessionOptions): Promise<{ session: AgentRunnerSession }> {
  const { session } = await createAgentSession(options);
  return { session };
}

function linkSessionAbort(signal: AbortSignal | undefined, session: AgentRunnerSession): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    void session.abort();
    return () => {};
  }
  const onAbort = () => {
    void session.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

type ToolSessionOptions = Pick<CreateAgentSessionOptions, "tools" | "excludeTools">;

interface ToolSelection {
  readonly sessionOptions: ToolSessionOptions;
  readonly fallbackSessionOptions: ToolSessionOptions;
  readonly activeTools?: readonly string[];
  readonly toolHints: NonNullable<AgentExecutionOptions["toolHints"]>;
}

interface DynamicToolSession extends AgentRunnerSession {
  getAllTools(): readonly AgentRunnerToolInfo[];
  setActiveToolsByName(toolNames: readonly string[]): void;
}

function buildToolSelection(opts: AgentExecutionOptions, skillsEnabled: boolean): ToolSelection {
  const toolHints = opts.toolHints ?? [];
  const fallback = toolHints.includes("search") ? DEFAULT_SEARCH_BASE_TOOLS : undefined;
  const activeTools = buildToolList(opts, skillsEnabled, fallback);
  const strictSessionOptions = { tools: activeTools ? [...activeTools] : undefined };
  if (toolHints.length === 0) {
    return { sessionOptions: strictSessionOptions, fallbackSessionOptions: strictSessionOptions, activeTools, toolHints };
  }

  const explicitlyActive = new Set(activeTools ?? []);
  return {
    sessionOptions: { excludeTools: BUILTIN_TOOL_NAMES.filter((name) => !explicitlyActive.has(name)) },
    fallbackSessionOptions: { tools: activeTools ? [...activeTools] : [] },
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

function applyDynamicToolHints(session: AgentRunnerSession, selection: ToolSelection): boolean {
  if (!hasDynamicToolApis(session)) return false;

  const active = new Set(selection.activeTools ?? []);
  for (const tool of session.getAllTools()) {
    if (selection.toolHints.some((hint) => hint === "search" && isSearchLikeTool(tool))) active.add(tool.name);
  }
  session.setActiveToolsByName([...active]);
  return true;
}

function hasDynamicToolApis(session: AgentRunnerSession): session is DynamicToolSession {
  return typeof session.getAllTools === "function" && typeof session.setActiveToolsByName === "function";
}

function isSearchLikeTool(tool: AgentRunnerToolInfo): boolean {
  if (/(?:^|[-_])(?:edit|write|replace|patch|apply|delete|remove|move|rename|create|commit|push)(?:$|[-_])/.test(tool.name.toLowerCase())) {
    return false;
  }
  const name = tool.name.toLowerCase();
  if (name.includes("grep") || name.includes("find") || name.includes("search") || name === "rg" || name.includes("ripgrep")) return true;
  return /\b(?:grep|find|search|ripgrep|rg|structural search|code search)\b/.test(tool.description?.toLowerCase() ?? "");
}

function shouldCreateSkillResourceLoader(rc: RunContext, prompt: string, opts: AgentExecutionOptions): boolean {
  return !rc.createSession || opts.skills !== undefined || extractSkillSelectorsFromText(prompt).length > 0;
}

function effectiveToolInfos(
  tools: readonly AgentRunnerToolInfo[],
): { readonly kind: "verified"; readonly tools: readonly EffectiveToolInfoLike[] } | { readonly kind: "unverifiable"; readonly reason: string } {
  const normalized: EffectiveToolInfoLike[] = [];
  for (const tool of tools) {
    if (typeof tool.description !== "string" || tool.parameters === undefined || !tool.sourceInfo) {
      return { kind: "unverifiable", reason: `active tool metadata is incomplete for ${tool.name}` };
    }
    normalized.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines,
      sourceInfo: tool.sourceInfo,
    });
  }
  return { kind: "verified", tools: normalized };
}

function lastAssistantText(state: { readonly messages: readonly unknown[] }): string {
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (hasRole(message, "assistant")) return messageTextContent(message).trim();
  }
  return "";
}

function hasRole(value: unknown, role: string): value is { role: string } {
  return typeof value === "object" && value !== null && "role" in value && value.role === role;
}

function messageTextContent(message: unknown): string {
  if (!hasContentArray(message)) return "";
  return message.content.filter(isTextPart).map((part) => part.text).join("");
}

function hasContentArray(value: unknown): value is { content: unknown[] } {
  return typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  );
}
