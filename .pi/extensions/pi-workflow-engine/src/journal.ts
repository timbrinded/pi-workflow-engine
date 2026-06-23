import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentOptions } from "./types.ts";

export const WORKFLOW_RUNS_DIR = join(".pi", ".workflow-runs");
export const WORKFLOW_JOURNAL_KEEP = 50;

export interface JournalEntry {
  readonly index: number;
  readonly hash: string;
  readonly value: unknown;
}

export type JournalLookup = { readonly hit: true; readonly value: unknown } | { readonly hit: false };

export interface WorkflowJournal {
  lookup(index: number, hash: string): JournalLookup;
  record(index: number, hash: string, value: unknown): Promise<void>;
}

export function createWorkflowRunId(): string {
  return randomUUID();
}

export function createAgentIndexCounter(): () => number {
  let next = 1;
  return () => next++;
}

export function workflowJournalPath(cwd: string, runId: string): string {
  return join(cwd, WORKFLOW_RUNS_DIR, `${validateRunId(runId)}.jsonl`);
}

export function hashAgentCall(prompt: string, opts: AgentOptions = {}): string {
  const behavior = {
    prompt,
    opts: {
      model: opts.model,
      thinkingLevel: opts.thinkingLevel,
      tools: sortedArray(opts.tools),
      toolHints: sortedArray(opts.toolHints),
      skills: sortedArray(opts.skills),
      schema: opts.schema,
    },
  };
  return createHash("sha256").update(stableStringify(behavior)).digest("hex");
}

export async function loadJournalEntries(path: string): Promise<JournalEntry[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }

  const entries: JournalEntry[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isJournalEntry(parsed)) entries.push(parsed);
    } catch {
      // Ignore corrupt lines. Resume is an optimization; corrupt cache data must
      // never make a workflow fail.
    }
  }
  return entries;
}

export async function createWorkflowJournal(options: {
  readonly resumePath?: string;
  readonly writePath: string;
}): Promise<WorkflowJournal> {
  const priorEntries = options.resumePath ? await loadJournalEntries(options.resumePath) : [];
  return createMemoryBackedJournal(priorEntries, options.writePath);
}

export function createMemoryBackedJournal(priorEntries: readonly JournalEntry[] = [], writePath?: string): WorkflowJournal {
  const priorByIndex = new Map<number, JournalEntry>();
  for (const entry of priorEntries) {
    priorByIndex.set(entry.index, entry);
  }
  let invalidated = priorEntries.length === 0;

  return {
    lookup(index, hash) {
      if (invalidated) return { hit: false };
      const entry = priorByIndex.get(index);
      if (!entry || entry.hash !== hash) {
        invalidated = true;
        return { hit: false };
      }
      return { hit: true, value: entry.value };
    },
    async record(index, hash, value) {
      const entry = { index, hash, value };
      if (writePath) {
        await mkdir(dirname(writePath), { recursive: true });
        await appendFile(writePath, `${JSON.stringify(entry)}\n`, "utf8");
      }
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
  const entry = value as { readonly index?: unknown; readonly hash?: unknown; readonly value?: unknown };
  return Number.isSafeInteger(entry.index) && typeof entry.hash === "string" && "value" in entry;
}
