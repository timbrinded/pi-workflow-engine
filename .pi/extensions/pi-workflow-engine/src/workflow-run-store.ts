import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { validateWorkflowRunId, WORKFLOW_RUNS_DIR } from "./journal.ts";
import type { WorkflowProgressSnapshot } from "./progress-types.ts";
import {
  isWorkflowRunRecord,
  transitionWorkflowRun,
  updateWorkflowRunProgress,
  type WorkflowRunRecord,
  type WorkflowRunTransition,
} from "./workflow-run-record.ts";

export const WORKFLOW_RUN_RECORD_KEEP = 50;
export const WORKFLOW_RUN_RECORD_SUFFIX = ".run.json";

const MAX_RECORD_BYTES = 4 << 20;

export interface WorkflowRunStore {
  save(record: WorkflowRunRecord): Promise<void>;
  load(runId: string): Promise<WorkflowRunRecord | undefined>;
  list(): Promise<WorkflowRunRecord[]>;
  prune(keep?: number): Promise<void>;
}

export class ProjectWorkflowRunStore implements WorkflowRunStore {
  constructor(private readonly cwd: string) {}

  async save(record: WorkflowRunRecord): Promise<void> {
    const path = workflowRunRecordPath(this.cwd, record.runId);
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const content = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) {
      throw new Error(`Workflow run record exceeded ${MAX_RECORD_BYTES} bytes.`);
    }
    await mkdir(dirname(path), { recursive: true });
    try {
      await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, path);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  async load(runId: string): Promise<WorkflowRunRecord | undefined> {
    return await loadWorkflowRunRecord(workflowRunRecordPath(this.cwd, runId));
  }

  async list(): Promise<WorkflowRunRecord[]> {
    const dir = join(this.cwd, WORKFLOW_RUNS_DIR);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(WORKFLOW_RUN_RECORD_SUFFIX))
        .map((file) => loadWorkflowRunRecord(join(dir, file))),
    );
    return records
      .filter((record): record is WorkflowRunRecord => record !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async prune(keep = WORKFLOW_RUN_RECORD_KEEP): Promise<void> {
    const dir = join(this.cwd, WORKFLOW_RUNS_DIR);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }
    const candidates = await Promise.all(
      files
        .filter((file) => file.endsWith(WORKFLOW_RUN_RECORD_SUFFIX))
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
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(Math.max(0, keep));
    await Promise.all(stale.map((entry) => rm(entry.path, { force: true }).catch(() => undefined)));
  }
}

/** Owns one run record and coalesces progress writes while a prior atomic save is in flight. */
export class DurableWorkflowRun {
  private record: WorkflowRunRecord;
  private pending: WorkflowRunRecord | undefined;
  private draining: Promise<void> | undefined;
  private writeFailure: unknown;
  private writeFailed = false;

  constructor(
    private readonly store: WorkflowRunStore,
    initial: WorkflowRunRecord,
    private readonly onWriteFailure?: (error: unknown) => void,
  ) {
    this.record = initial;
    this.queue(initial);
  }

  updateProgress(progress: WorkflowProgressSnapshot, at = Date.now()): void {
    this.record = updateWorkflowRunProgress(this.record, progress, at);
    this.queue(this.record);
  }

  transition(transition: WorkflowRunTransition): void {
    this.record = transitionWorkflowRun(this.record, transition);
    this.queue(this.record);
  }

  async flush(): Promise<void> {
    while (this.draining) await this.draining;
    if (this.writeFailed) throw this.writeFailure;
  }

  private queue(record: WorkflowRunRecord): void {
    this.pending = record;
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.pending) this.queue(this.pending);
    });
  }

  private async drain(): Promise<void> {
    while (this.pending) {
      const next = this.pending;
      this.pending = undefined;
      try {
        await this.store.save(next);
      } catch (error) {
        this.writeFailed = true;
        this.writeFailure = error;
        try {
          this.onWriteFailure?.(error);
        } catch {
          // Persistence observers must not create an unhandled rejection.
        }
      }
    }
  }
}

export function workflowRunRecordPath(cwd: string, runId: string): string {
  return join(cwd, WORKFLOW_RUNS_DIR, `${validateWorkflowRunId(runId)}${WORKFLOW_RUN_RECORD_SUFFIX}`);
}

async function loadWorkflowRunRecord(path: string): Promise<WorkflowRunRecord | undefined> {
  try {
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) return undefined;
    const parsed = JSON.parse(content) as unknown;
    if (!isWorkflowRunRecord(parsed)) return undefined;
    const file = basename(path);
    const pathRunId = file.slice(0, -WORKFLOW_RUN_RECORD_SUFFIX.length);
    return parsed.runId === pathRunId ? parsed : undefined;
  } catch {
    return undefined;
  }
}
