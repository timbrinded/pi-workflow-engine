import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentOptions } from "./types.ts";
import type { WorktreeBaseline } from "./worktree.ts";
import {
  isAgentResumeContext,
  resumeContextMismatchReason,
  type AgentResumeContext,
} from "./resume-context.ts";

export const WORKFLOW_RUNS_DIR = join(".pi", ".workflow-runs");
export const WORKFLOW_JOURNAL_KEEP = 50;

export interface JournalEntry {
  readonly key: string;
  readonly value: unknown;
  /** Missing only on journals written before execution-context validation existed. */
  readonly context?: AgentResumeContext;
}

export type JournalLookup = { readonly hit: true; readonly value: unknown } | { readonly hit: false; readonly reason?: string };
export type JournalRecordResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface WorkflowJournal {
  lookup(key: string, context: AgentResumeContext): JournalLookup;
  record(key: string, value: unknown, context: AgentResumeContext): Promise<JournalRecordResult>;
}

export class WorkflowJournalLoadError extends Error {
  override readonly name = "WorkflowJournalLoadError";
}

export function createWorkflowRunId(): string {
  return randomUUID();
}

export function workflowJournalPath(cwd: string, runId: string): string {
  return join(cwd, WORKFLOW_RUNS_DIR, `${validateRunId(runId)}.jsonl`);
}

export function agentJournalKey(prompt: string, opts: AgentOptions = {}, worktreeBaseline?: WorktreeBaseline): string {
  const behaviorHash = hashAgentCall(prompt, opts, worktreeBaseline);
  const cacheKey = opts.cacheKey?.trim();
  if (!cacheKey) return `agent:${behaviorHash}`;
  const cacheKeyHash = createHash("sha256").update(cacheKey).digest("hex");
  return `agent:${cacheKeyHash}:${behaviorHash}`;
}

export function hashAgentCall(prompt: string, opts: AgentOptions = {}, worktreeBaseline?: WorktreeBaseline): string {
  const behavior = {
    prompt,
    opts: {
      thinkingLevel: opts.thinkingLevel,
      tools: sortedArray(opts.tools),
      toolHints: sortedArray(opts.toolHints),
      skills: sortedArray(opts.skills),
      schema: opts.schema,
      isolation: opts.isolation,
      worktreeBaseline: worktreeBaseline
        ? {
            ref: worktreeBaseline.ref,
            patchFingerprint: createHash("sha256").update(worktreeBaseline.patch ?? "").digest("hex"),
          }
        : undefined,
    },
  };
  return createHash("sha256").update(stableStringify(behavior)).digest("hex");
}

export async function loadJournalEntries(path: string, options: { readonly required?: boolean } = {}): Promise<JournalEntry[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (options.required) {
      throw new WorkflowJournalLoadError(`Could not load workflow resume journal at ${path}: ${formatError(error)}`);
    }
    return [];
  }

  const entries: JournalEntry[] = [];
  let lineNumber = 0;
  for (const line of content.split(/\r?\n/)) {
    lineNumber += 1;
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isJournalEntry(parsed)) {
        entries.push(parsed);
        continue;
      }
      if (options.required) {
        throw new WorkflowJournalLoadError(`Workflow resume journal at ${path}:${lineNumber} has an incompatible entry format.`);
      }
    } catch (error) {
      if (options.required) {
        if (error instanceof WorkflowJournalLoadError) throw error;
        throw new WorkflowJournalLoadError(`Workflow resume journal at ${path}:${lineNumber} is not valid JSON.`);
      }
    }
  }
  return entries;
}

export async function createWorkflowJournal(options: {
  readonly resumePath?: string;
  readonly writePath: string;
}): Promise<WorkflowJournal> {
  const priorEntries = options.resumePath ? await loadJournalEntries(options.resumePath, { required: true }) : [];
  return createMemoryBackedJournal(priorEntries, options.writePath);
}

export function createMemoryBackedJournal(priorEntries: readonly JournalEntry[] = [], writePath?: string): WorkflowJournal {
  const priorByKey = new Map<string, JournalEntry[]>();
  for (const entry of priorEntries) {
    const entries = priorByKey.get(entry.key) ?? [];
    entries.push(entry);
    priorByKey.set(entry.key, entries);
  }

  return {
    lookup(key, context) {
      const entries = priorByKey.get(key);
      if (!entries || entries.length === 0) return { hit: false };

      const contextual = entries.filter((entry): entry is JournalEntry & { readonly context: AgentResumeContext } => entry.context !== undefined);
      if (contextual.length === 0) return { hit: false, reason: "legacy journal entry has no execution context" };
      const matches = contextual.filter((entry) => resumeContextsEqual(entry.context, context));
      if (matches.length === 1) return { hit: true, value: matches[0]!.value };
      if (matches.length > 1) return { hit: false, reason: "multiple cached entries match this agent call" };
      return { hit: false, reason: resumeContextMismatchReason(contextual[0]!.context, context) };
    },
    async record(key, value, context) {
      const entry: JournalEntry = { key, value, context };
      if (writePath) {
        try {
          await mkdir(dirname(writePath), { recursive: true });
          await appendFile(writePath, `${JSON.stringify(entry)}\n`, "utf8");
        } catch (error) {
          return { ok: false, error: formatError(error) };
        }
      }
      return { ok: true };
    },
  };
}

export async function pruneWorkflowJournals(cwd: string, keep = WORKFLOW_JOURNAL_KEEP): Promise<void> {
  const dir = join(cwd, WORKFLOW_RUNS_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }

  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) => {
        const path = join(dir, file);
        try {
          const info = await stat(path);
          return { path, mtimeMs: info.mtimeMs };
        } catch {
          return undefined;
        }
      }),
  );

  const stale = candidates
    .filter((entry): entry is { readonly path: string; readonly mtimeMs: number } => entry !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(Math.max(0, keep));

  await Promise.all(stale.map((entry) => rm(entry.path, { force: true }).catch(() => undefined)));
}

function validateRunId(runId: string): string {
  const trimmed = runId.trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw new Error("Workflow run id must contain only letters, numbers, dots, underscores, or hyphens.");
  }
  return trimmed;
}

function sortedArray(values: readonly string[] | undefined): readonly string[] | undefined {
  return values ? [...values].sort() : undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeStable(value));
}

function normalizeStable(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalizeStable);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = normalizeStable(record[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as { readonly key?: unknown; readonly value?: unknown; readonly context?: unknown };
  return typeof entry.key === "string" && "value" in entry && (entry.context === undefined || isAgentResumeContext(entry.context));
}

function resumeContextsEqual(left: AgentResumeContext, right: AgentResumeContext): boolean {
  return resumeContextMismatchReason(left, right) === undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
