import { createAgentSession, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CreateAgentSessionOptions, ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentOptions } from "./types.ts";
import type { Semaphore } from "./concurrency.ts";
import type { PerfSink } from "./perf.ts";
import type { WorkflowUsageSink } from "./usage.ts";
import { throwIfAborted } from "./cancellation.ts";
import { appendSkillReminder, createAgentSkillResourceLoader } from "./agent-skills.ts";

/** Name of the synthetic terminating tool that carries structured output. */
const FINAL_TOOL = "final_answer";

export interface AgentRunnerEvent {
  readonly type: string;
  readonly toolName?: string;
}

export interface AgentRunnerSession {
  readonly state: { readonly messages: readonly unknown[] };
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: AgentRunnerEvent) => void): () => void;
  dispose(): void;
  abort(): Promise<void>;
}

export type CreateAgentSession = (options: CreateAgentSessionOptions) => Promise<{ session: AgentRunnerSession }>;

export interface AgentProgress {
  agentQueued(phase: string | undefined, label: string): number;
  agentStart(phase: string | undefined, label: string, id?: number): void;
  agentTool(label: string, tool: string, id?: number): void;
  agentDone(label: string, id?: number): void;
  agentFailed(label: string, error: unknown, id?: number): void;
  log(message: string): void;
}

/** Shared per-run context threaded into every agent() call. */
export interface RunContext {
  cwd: string;
  hostModel: Model<Api> | undefined;
  modelRegistry: Pick<ModelRegistry, "find">;
  semaphore: Semaphore;
  progress: AgentProgress;
  signal: AbortSignal | undefined;
  perf: PerfSink;
  usage: WorkflowUsageSink;
  createSession?: CreateAgentSession;
}

export interface ResolvedAgentModelRequest {
  readonly ref: string;
  readonly provider: string;
  readonly id: string;
}

export interface ResolvedAgentModel {
  readonly model: Model<Api> | undefined;
  readonly requested: ResolvedAgentModelRequest | undefined;
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
  if (slash === -1) {
    return { ref: modelRef, provider: "anthropic", id: modelRef };
  }

  const provider = modelRef.slice(0, slash);
  const id = modelRef.slice(slash + 1);
  if (provider.length === 0 || id.length === 0 || id.startsWith("/")) {
    throw new Error(`Invalid agent model ref "${modelRef}": expected "provider/id".`);
  }
  return { ref: modelRef, provider, id };
}

/**
 * Resolve a workflow agent model reference.
 *
 * Omitted refs inherit the host/session default model. Explicit refs are strict:
 * bare model ids keep the original Anthropic shorthand for compatibility, and
 * provider-qualified refs split only on the first slash so provider routers such
 * as OpenRouter can use ids that contain additional slashes.
 */
export function resolveAgentModel(
  modelRef: string | undefined,
  modelRegistry: Pick<ModelRegistry, "find">,
  hostModel: Model<Api> | undefined,
): ResolvedAgentModel {
  if (modelRef === undefined) {
    return { model: hostModel, requested: undefined };
  }

  const parsed = parseAgentModelRef(modelRef);
  const found = modelRegistry.find(parsed.provider, parsed.id);
  if (!found) {
    throw new Error(`Agent model "${modelRef}" not found (resolved as ${parsed.provider}/${parsed.id}).`);
  }

  return { model: found, requested: parsed };
}

/** Pull the last assistant message's plain text out of a finished session. */
function lastAssistantText(state: { readonly messages: readonly unknown[] }): string {
  const messages = state.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (hasRole(message, "assistant")) {
      return messageTextContent(message).trim();
    }
  }
  return "";
}

function hasRole(value: unknown, role: string): value is { role: string } {
  return typeof value === "object" && value !== null && "role" in value && value.role === role;
}

function messageTextContent(message: unknown): string {
  if (!hasContentArray(message)) return "";
  return message.content
    .filter(isTextPart)
    .map((part) => part.text)
    .join("");
}

function hasContentArray(value: unknown): value is { content: unknown[] } {
  return typeof value === "object" && value !== null && "content" in value && Array.isArray(value.content);
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return typeof value === "object" && value !== null && "type" in value && value.type === "text" && "text" in value && typeof value.text === "string";
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

function buildToolAllowlist(opts: AgentOptions, skillsEnabled: boolean): string[] | undefined {
  if (!opts.tools) return undefined;
  const allow = [...opts.tools];
  if (skillsEnabled && !allow.includes("read")) allow.push("read");
  if (opts.schema && !allow.includes(FINAL_TOOL)) allow.push(FINAL_TOOL);
  return allow;
}

/**
 * Run one subagent to completion in an isolated in-memory session.
 *
 * Structured output trick: when `opts.schema` is set we register a single
 * terminating tool whose `parameters` IS the schema. The agent's last action is to
 * call it; pi validates the args against the schema, hands them to `execute`, and
 * `terminate: true` ends the turn with no extra LLM round-trip. We capture those
 * validated args in a closure — that captured object is the structured result, so
 * no event-stream parsing is needed.
 */
export async function runAgent(rc: RunContext, prompt: string, opts: AgentOptions = {}): Promise<unknown> {
  const label = opts.label ?? "agent";
  const phase = opts.phase ?? "Workflow";
  const tags = { label, phase };

  return await rc.perf.time("agent.total_ms", async () => {
    throwIfAborted(rc.signal);
    // Track queued agents before acquiring a global concurrency slot.
    const rowId = rc.progress.agentQueued(opts.phase, label);
    let failureHandled = false;
    try {
      return await rc.semaphore.run(
        async () => {
        throwIfAborted(rc.signal);
        rc.progress.agentStart(opts.phase, label, rowId);

        let captured: unknown = null;
        let failed = false;
        let session: AgentRunnerSession | undefined;
        let usageRecorded = false;
        let unsubscribe: (() => void) | undefined;
        const recordUsage = (activeSession: AgentRunnerSession): void => {
          if (usageRecorded) return;
          usageRecorded = true;
          rc.usage.recordAgentSession({ label, phase, messages: activeSession.state.messages });
        };
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

        try {
          const skillSetup = rc.createSession
            ? undefined
            : await rc.perf.time(
                "agent.skills_ms",
                () =>
                  createAgentSkillResourceLoader({
                    cwd: rc.cwd,
                    prompt,
                    skills: opts.skills,
                    log: (message) => rc.progress.log(`${label}: ${message}`),
                  }),
                tags,
              );
          const selectedSkills = skillSetup?.selectedSkills ?? [];
          // When the workflow restricts built-in tools, keep the terminating tool visible.
          // Skill opt-ins also need read so the subagent can load SKILL.md on demand.
          const allow = buildToolAllowlist(opts, selectedSkills.length > 0);

          const { model } = resolveAgentModel(opts.model, rc.modelRegistry, rc.hostModel);
          const createSessionForRun = rc.createSession ?? defaultCreateSession;

          throwIfAborted(rc.signal);
          const created = await rc.perf.time(
            "agent.create_session_ms",
            () =>
              createSessionForRun({
                cwd: rc.cwd,
                model,
                modelRegistry: rc.modelRegistry as ModelRegistry,
                thinkingLevel: opts.thinkingLevel,
                tools: allow,
                customTools,
                resourceLoader: skillSetup?.resourceLoader,
                sessionManager: SessionManager.inMemory(rc.cwd),
              }),
            tags,
          );
          session = created.session;
          const activeSession = session;
          throwIfAborted(rc.signal);

          unsubscribe = activeSession.subscribe((event) => {
            if (event.type === "tool_execution_start" && event.toolName !== undefined && event.toolName !== FINAL_TOOL) {
              rc.progress.agentTool(label, event.toolName, rowId);
            }
          });

          const promptedWithSkills = appendSkillReminder(prompt, selectedSkills);
          const finalPrompt = opts.schema
            ? `${promptedWithSkills}\n\nWhen finished, return your result by calling the ${FINAL_TOOL} tool.`
            : promptedWithSkills;
          throwIfAborted(rc.signal);
          const unlinkPromptAbort = linkSessionAbort(rc.signal, activeSession);
          try {
            await rc.perf.time("agent.prompt_ms", () => activeSession.prompt(finalPrompt), tags);
          } finally {
            unlinkPromptAbort();
          }
          recordUsage(activeSession);
          throwIfAborted(rc.signal);

          return rc.perf.timeSync(
            "agent.extract_result_ms",
            () => {
              if (opts.schema) {
                if (captured === null) {
                  rc.progress.log(`${label}: no structured answer returned`);
                  rc.perf.counter("agent.structured_missing", 1, tags);
                }
                return captured;
              }
              return lastAssistantText(activeSession.state);
            },
            tags,
          );
        } catch (error) {
          failed = true;
          failureHandled = true;
          rc.progress.agentFailed(label, error, rowId);
          rc.progress.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        } finally {
          const disposable = session;
          if (disposable) {
            recordUsage(disposable);
            rc.perf.timeSync(
              "agent.dispose_ms",
              () => {
                unsubscribe?.();
                disposable.dispose();
              },
              tags,
            );
          }
          if (!failed) rc.progress.agentDone(label, rowId);
        }
        },
        { onQueueWaitMs: (durationMs) => rc.perf.observe("agent.queue_wait_ms", durationMs, tags), signal: rc.signal },
      );
    } catch (error) {
      if (!failureHandled) {
        rc.progress.agentFailed(label, error, rowId);
        rc.progress.log(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }, tags);
}
