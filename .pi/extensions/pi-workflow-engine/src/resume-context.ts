import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { throwIfAborted } from "./cancellation.ts";
import type {
  EffectiveAgentSessionIdentity,
  EffectiveToolIdentity,
} from "./agent-session-identity.ts";
import { runBoundedProcess, type BoundedProcessResult } from "./process-runner.ts";
import {
  BoundedFingerprint,
  captureDeclaredInputFingerprint,
  captureTreeFingerprint,
  isPathWithin,
  resolveDeclaredInputPaths,
  validateTreeFile,
  type FingerprintCapture,
} from "./tree-fingerprint.ts";
import type { LoadedWorkflow } from "./types.ts";
import { canonicalizeIdentity } from "./identity-canonicalization.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

export type VerifiedRepositoryResumeContext =
  | {
      readonly kind: "verified";
      readonly state: "git" | "isolated";
      readonly head: string;
      readonly workingTreeFingerprint: string;
    }
  | {
      readonly kind: "verified";
      readonly state: "unborn" | "non-git" | "inaccessible";
      readonly workingTreeFingerprint: string;
    };

export type RepositoryResumeContext =
  | VerifiedRepositoryResumeContext
  | { readonly kind: "unverifiable"; readonly reason: string };

export type VerifiedWorkflowResumeContext = {
  readonly kind: "verified";
  readonly name: string;
  readonly sourceFingerprint: string;
};

export type WorkflowResumeContext =
  | VerifiedWorkflowResumeContext
  | { readonly kind: "unverifiable"; readonly name: string; readonly reason: string };

export interface ResolvedSkillIdentity {
  readonly name: string;
  readonly path: string;
  readonly fingerprint: string;
}

export interface AgentResumeBaseContext {
  readonly workflow: WorkflowResumeContext;
}

export interface VerifiedAgentResumeBaseContext {
  readonly workflow: VerifiedWorkflowResumeContext;
}

export interface AgentResumeContext extends VerifiedAgentResumeBaseContext {
  readonly repository: VerifiedRepositoryResumeContext;
  readonly session: EffectiveAgentSessionIdentity;
  readonly skills: readonly ResolvedSkillIdentity[];
}

type RepositoryRevision =
  | { readonly state: "git"; readonly head: string }
  | { readonly state: "unborn" };

type RepositoryInspection =
  | { readonly kind: "git"; readonly root: string; readonly revision: RepositoryRevision }
  | { readonly kind: "non-git" }
  | { readonly kind: "unverifiable"; readonly reason: string };

type BoundedProcessFailureResult = Extract<BoundedProcessResult, { readonly ok: false }>;

const GIT_CONTEXT_TIMEOUT_MS = 15_000;
const GIT_CONTEXT_MAX_BYTES = 32 << 20;
const CONTENT_FINGERPRINT_MAX_BYTES = 32 << 20;
const SOURCE_TREE_MAX_FILES = 4096;
const REPOSITORY_INPUT_MAX_ENTRIES = 4096;
const GIT_UNTRACKED_MAX_ENTRIES = 32_768;
const GIT_VISIBLE_PATHS = [
  ".",
  ":(exclude).pi/.workflow-runs/**",
  ":(glob,exclude)**/.pi/.workflow-runs/**",
] as const;
export const FINGERPRINT_EXCLUDED_RELATIVE_PATHS = new Set([
  ".git",
  ".pi/.workflow-runs",
]);

export function unverifiableRepositoryResumeContext(reason: string): RepositoryResumeContext {
  return { kind: "unverifiable", reason };
}

export function unverifiableWorkflowResumeContext(name: string, reason: string): WorkflowResumeContext {
  return { kind: "unverifiable", name, reason };
}

export async function captureRepositoryResumeContext(
  cwd: string,
  additionalInputs: readonly string[],
  signal?: AbortSignal,
): Promise<RepositoryResumeContext> {
  const repository = await inspectRepository(cwd, signal);
  if (repository.kind === "unverifiable") return repository;
  if (repository.kind === "non-git") {
    return await captureNonGitRepositoryContext(cwd, [".", ...additionalInputs], signal);
  }

  const resolvedInputs = resolveDeclaredInputPaths(
    repository.root,
    additionalInputs,
    FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    cwd,
  );
  if (resolvedInputs.kind === "unverifiable") return resolvedInputs;
  const [gitVisible, explicit] = await Promise.all([
    captureGitVisibleState(repository.root, signal),
    captureRepositoryInputs(repository.root, resolvedInputs.paths, signal),
  ]);
  if (gitVisible.kind === "unverifiable") return gitVisible;
  if (explicit.kind === "unverifiable") return explicit;
  return {
    kind: "verified",
    ...repository.revision,
    workingTreeFingerprint: combineFingerprints([
      ["git-visible", gitVisible.fingerprint],
      ["explicit-inputs", explicit.fingerprint],
    ]),
  };
}

/** Bind isolated replay to the exact immutable commit and tree prepared for its disposable workspace. */
export async function captureIsolatedRepositoryContext(
  cwd: string,
  baselineOid: string,
  signal?: AbortSignal,
): Promise<RepositoryResumeContext> {
  try {
    if (!isGitObjectId(baselineOid)) {
      return { kind: "unverifiable", reason: "isolated baseline is not a full commit object ID" };
    }
    const [commit, tree, entries] = await Promise.all([
      runGit(cwd, ["rev-parse", "--verify", `${baselineOid}^{commit}`], signal),
      runGit(cwd, ["rev-parse", "--verify", `${baselineOid}^{tree}`], signal),
      runGit(cwd, ["ls-tree", "-r", "-z", "--full-tree", baselineOid], signal),
    ]);
    throwIfAborted(signal);
    if (!commit.ok) return { kind: "unverifiable", reason: processFailureReason("isolated baseline commit probe", commit) };
    if (!tree.ok) return { kind: "unverifiable", reason: processFailureReason("isolated baseline tree probe", tree) };
    if (!entries.ok) return { kind: "unverifiable", reason: processFailureReason("isolated baseline entry capture", entries) };

    const commitOid = commit.stdout.trim();
    const treeOid = tree.stdout.trim();
    if (!isGitObjectId(commitOid)) {
      return { kind: "unverifiable", reason: "isolated baseline commit probe returned an invalid object ID" };
    }
    if (!isGitObjectId(treeOid)) {
      return { kind: "unverifiable", reason: "isolated baseline tree probe returned an invalid object ID" };
    }
    for (const record of parseNullTerminatedRecords(entries.stdout, "isolated baseline entry capture")) {
      const entry = parseTreeEntry(record);
      const unsafe = unsafeTrackedModeReason(entry.mode, entry.path);
      if (unsafe) return { kind: "unverifiable", reason: unsafe };
    }
    return { kind: "verified", state: "isolated", head: commitOid, workingTreeFingerprint: treeOid };
  } catch (error) {
    throwIfAborted(signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

async function captureNonGitRepositoryContext(
  cwd: string,
  inputs: readonly string[],
  signal: AbortSignal | undefined,
): Promise<RepositoryResumeContext> {
  const capture = await captureRepositoryInputs(cwd, inputs, signal);
  return capture.kind === "verified"
    ? { kind: "verified", state: "non-git", workingTreeFingerprint: capture.fingerprint }
    : unverifiableRepositoryResumeContext(capture.reason);
}

async function captureRepositoryInputs(
  cwd: string,
  inputs: readonly string[],
  signal: AbortSignal | undefined,
): Promise<FingerprintCapture> {
  return await captureDeclaredInputFingerprint({
    root: cwd,
    inputs,
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    maxBytes: CONTENT_FINGERPRINT_MAX_BYTES,
    maxEntries: REPOSITORY_INPUT_MAX_ENTRIES,
    signal,
  });
}

/**
 * Capture Git-visible dirty state around an isolated attempt.
 *
 * This guard is intentionally transient rather than part of replay identity:
 * isolated results bind to their worktree baseline, while this snapshot only
 * detects main-checkout mutations without rereading every clean tracked file.
 */
export async function captureRepositoryMutationGuard(
  cwd: string,
  signal?: AbortSignal,
): Promise<FingerprintCapture> {
  const repository = await inspectRepository(cwd, signal);
  if (repository.kind === "unverifiable") return repository;
  if (repository.kind === "non-git") {
    return { kind: "unverifiable", reason: "isolated mutation guard requires a Git worktree" };
  }
  const visible = await captureGitVisibleState(repository.root, signal);
  if (visible.kind === "unverifiable") return visible;
  return {
    kind: "verified",
    fingerprint: combineFingerprints([
      ["revision-state", repository.revision.state],
      ["revision-head", repository.revision.state === "git" ? repository.revision.head : "unborn"],
      ["git-visible", visible.fingerprint],
    ]),
  };
}

async function inspectRepository(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RepositoryInspection> {
  throwIfAborted(signal);
  const probe = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], signal);
  throwIfAborted(signal);
  if (!probe.ok) {
    if (probe.failure.kind === "exit") {
      const marker = await findGitControlPath(cwd, signal);
      if (marker.kind === "absent") return { kind: "non-git" };
      if (marker.kind === "unknown") return { kind: "unverifiable", reason: marker.reason };
    }
    return { kind: "unverifiable", reason: processFailureReason("git repository probe", probe) };
  }

  const insideWorkTree = probe.stdout.trim();
  if (insideWorkTree === "false") return { kind: "non-git" };
  if (insideWorkTree !== "true") {
    return { kind: "unverifiable", reason: `git repository probe returned an unexpected value: ${insideWorkTree || "<empty>"}` };
  }

  const [rootResult, headResult] = await Promise.all([
    runGit(cwd, ["rev-parse", "--show-toplevel"], signal),
    runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], signal),
  ]);
  throwIfAborted(signal);
  if (!rootResult.ok) {
    return { kind: "unverifiable", reason: processFailureReason("git top-level probe", rootResult) };
  }
  const root = parseGitTopLevel(rootResult.stdout, cwd);
  if (!root) return { kind: "unverifiable", reason: "git top-level probe returned an invalid path" };
  if (headResult.ok) {
    const head = headResult.stdout.trim();
    return isGitObjectId(head)
      ? { kind: "git", root, revision: { state: "git", head } }
      : { kind: "unverifiable", reason: "git HEAD probe returned an invalid revision" };
  }
  return headResult.failure.kind === "exit" && headResult.failure.code === 1
    ? { kind: "git", root, revision: { state: "unborn" } }
    : { kind: "unverifiable", reason: processFailureReason("git HEAD probe", headResult) };
}

async function captureGitVisibleState(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<FingerprintCapture> {
  try {
    return await captureGitVisibleStateUnchecked(cwd, signal);
  } catch (error) {
    throwIfAborted(signal);
    return { kind: "unverifiable", reason: unknownErrorMessage(error) };
  }
}

async function captureGitVisibleStateUnchecked(
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<FingerprintCapture> {
  const diffFlags = [
    "--binary",
    "--full-index",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--ignore-submodules=none",
  ] as const;
  const [unstaged, unstagedRaw, staged, untrackedPaths, indexEntries, trackedFlags] = await Promise.all([
    runGit(cwd, ["diff", ...diffFlags, "--", ...GIT_VISIBLE_PATHS], signal),
    runGit(cwd, ["diff", "--raw", "-z", "--no-abbrev", "--no-renames", ...diffFlags.slice(2), "--", ...GIT_VISIBLE_PATHS], signal),
    runGit(cwd, ["diff", "--cached", ...diffFlags, "--", ...GIT_VISIBLE_PATHS], signal),
    runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...GIT_VISIBLE_PATHS], signal),
    runGit(cwd, ["ls-files", "--stage", "--full-name", "-z"], signal),
    runGit(cwd, ["ls-files", "-v", "--full-name", "-z"], signal),
  ]);
  throwIfAborted(signal);

  for (const [operation, result] of [
    ["unstaged diff capture", unstaged],
    ["unstaged mode capture", unstagedRaw],
    ["staged diff capture", staged],
    ["untracked path capture", untrackedPaths],
    ["index entry capture", indexEntries],
    ["tracked flag capture", trackedFlags],
  ] as const) {
    if (!result.ok) return { kind: "unverifiable", reason: processFailureReason(`git ${operation}`, result) };
  }

  const unsafeWorktreeMode = rawWorktreeModeFailure(unstagedRaw.stdout);
  if (unsafeWorktreeMode) return { kind: "unverifiable", reason: unsafeWorktreeMode };

  for (const record of parseNullTerminatedRecords(indexEntries.stdout, "git index entry capture")) {
    const entry = parseIndexEntry(record);
    if (entry.stage !== 0) {
      return { kind: "unverifiable", reason: "git-visible repository state contains unmerged paths" };
    }
    const unsafe = unsafeTrackedModeReason(entry.mode, entry.path);
    if (unsafe) return { kind: "unverifiable", reason: unsafe };
  }

  const unsafeFlag = parseNullTerminatedRecords(trackedFlags.stdout, "git tracked flag capture")
    .find((record) => record[0] !== "H");
  if (unsafeFlag) {
    return {
      kind: "unverifiable",
      reason: `git-visible repository state contains an unsupported tracked-file flag: ${unsafeFlag[0] ?? "unknown"}`,
    };
  }

  const untracked = await captureDeclaredInputFingerprint({
    root: cwd,
    inputs: parseNullTerminatedRecords(untrackedPaths.stdout, "git untracked path capture")
      .filter((path) => !isFingerprintExcludedPath(path)),
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    maxBytes: CONTENT_FINGERPRINT_MAX_BYTES,
    maxEntries: GIT_UNTRACKED_MAX_ENTRIES,
    signal,
  });
  if (untracked.kind === "unverifiable") return untracked;

  return {
    kind: "verified",
    fingerprint: combineFingerprints([
      ["unstaged", unstaged.stdout],
      ["staged", staged.stdout],
      ["index", indexEntries.stdout],
      ["untracked", untracked.fingerprint],
    ]),
  };
}

function combineFingerprints(parts: readonly (readonly [label: string, value: string])[]): string {
  const fingerprint = new BoundedFingerprint(0);
  for (const [label, value] of parts) fingerprint.add(label, value);
  return fingerprint.digest();
}

interface GitIndexEntry {
  readonly mode: string;
  readonly stage: number;
  readonly path: string;
}

function parseIndexEntry(record: string): GitIndexEntry {
  const separator = record.indexOf("\t");
  if (separator < 0) throw new Error("git index entry capture returned malformed data");
  const match = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/i.exec(record.slice(0, separator));
  if (!match) throw new Error("git index entry capture returned malformed metadata");
  return { mode: match[1]!, stage: Number(match[3]), path: record.slice(separator + 1) };
}

function parseTreeEntry(record: string): { readonly mode: string; readonly path: string } {
  const separator = record.indexOf("\t");
  if (separator < 0) throw new Error("isolated baseline entry capture returned malformed data");
  const match = /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40,64})$/i.exec(record.slice(0, separator));
  if (!match) throw new Error("isolated baseline entry capture returned malformed metadata");
  return { mode: match[1]!, path: record.slice(separator + 1) };
}

function unsafeTrackedModeReason(mode: string, path: string): string | undefined {
  if (mode === "120000") return `repository replay does not support tracked symbolic links: ${path}`;
  if (mode === "160000") return `repository replay does not support tracked submodules: ${path}`;
  return mode === "100644" || mode === "100755"
    ? undefined
    : `repository replay encountered unsupported tracked mode ${mode}: ${path}`;
}

function rawWorktreeModeFailure(output: string): string | undefined {
  const records = parseNullTerminatedRecords(output, "git unstaged mode capture");
  if (records.length % 2 !== 0) throw new Error("git unstaged mode capture returned incomplete data");
  for (let index = 0; index < records.length; index += 2) {
    const header = records[index]!;
    const path = records[index + 1]!;
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) ([A-Z][0-9]*)$/i.exec(header);
    if (!match || path.length === 0) throw new Error("git unstaged mode capture returned malformed data");
    if (match[2] === "000000") continue;
    const unsafe = unsafeTrackedModeReason(match[2]!, path);
    if (unsafe) return unsafe;
  }
  return undefined;
}

export async function captureWorkflowResumeContext(
  mod: LoadedWorkflow,
  signal?: AbortSignal,
): Promise<WorkflowResumeContext> {
  throwIfAborted(signal);
  if (mod.source.kind === "unverifiable") {
    return unverifiableWorkflowResumeContext(mod.meta.name, mod.source.reason);
  }
  if (mod.source.kind === "fingerprint") {
    return mod.source.fingerprint.length > 0
      ? { kind: "verified", name: mod.meta.name, sourceFingerprint: mod.source.fingerprint }
      : unverifiableWorkflowResumeContext(mod.meta.name, "workflow source fingerprint is empty");
  }

  const sourcePath = resolve(mod.source.path);
  const sourceRoot = resolve(mod.source.root);
  if (!isPathWithin(sourceRoot, sourcePath)) {
    return unverifiableWorkflowResumeContext(mod.meta.name, "workflow source file is outside its declared source root");
  }
  const validation = await validateTreeFile({
    root: sourceRoot,
    path: sourcePath,
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    signal,
  });
  if (validation.kind === "unverifiable") {
    return unverifiableWorkflowResumeContext(mod.meta.name, `workflow source file is not part of its source tree: ${validation.reason}`);
  }

  const current = await captureTreeFingerprint({
    root: sourceRoot,
    excludedRelativePaths: FINGERPRINT_EXCLUDED_RELATIVE_PATHS,
    maxBytes: CONTENT_FINGERPRINT_MAX_BYTES,
    maxFiles: SOURCE_TREE_MAX_FILES,
    signal,
  });
  if (current.kind === "unverifiable") {
    return unverifiableWorkflowResumeContext(mod.meta.name, `workflow source tree could not be verified: ${current.reason}`);
  }
  if (current.fingerprint !== mod.source.fingerprint) {
    return unverifiableWorkflowResumeContext(mod.meta.name, "workflow source tree changed after the module loaded");
  }
  return { kind: "verified", name: mod.meta.name, sourceFingerprint: mod.source.fingerprint };
}

export function createAgentResumeContext(
  base: VerifiedAgentResumeBaseContext,
  repository: VerifiedRepositoryResumeContext,
  session: EffectiveAgentSessionIdentity,
  skills: readonly ResolvedSkillIdentity[],
): AgentResumeContext {
  return {
    ...base,
    repository,
    session,
    skills: [...skills],
  };
}

export function resumeContextMismatchReason(stored: AgentResumeContext, current: AgentResumeContext): string | undefined {
  if (stored.repository.state !== current.repository.state) return "repository state changed";
  if (
    (stored.repository.state === "git" || stored.repository.state === "isolated") &&
    (current.repository.state === "git" || current.repository.state === "isolated") &&
    stored.repository.head !== current.repository.head
  ) {
    return stored.repository.state === "git" ? "repository HEAD changed" : "isolated baseline changed";
  }
  if (stored.repository.workingTreeFingerprint !== current.repository.workingTreeFingerprint) {
    return "working tree contents changed";
  }
  if (stored.workflow.name !== current.workflow.name) return "workflow name changed";
  if (stored.workflow.sourceFingerprint !== current.workflow.sourceFingerprint) return "workflow source changed";
  if (stored.session.runtimeVersion !== current.session.runtimeVersion) return "coding-agent runtime changed";
  if (stored.session.systemPromptFingerprint !== current.session.systemPromptFingerprint) return "effective system prompt changed";
  if (
    stored.session.model.provider !== current.session.model.provider ||
    stored.session.model.id !== current.session.model.id
  ) {
    return "effective model changed";
  }
  if (stored.session.thinkingLevel !== current.session.thinkingLevel) return "effective thinking level changed";
  const storedSession = canonicalizeIdentity(stored.session);
  const currentSession = canonicalizeIdentity(current.session);
  if (storedSession.kind === "unverifiable" || currentSession.kind === "unverifiable") {
    return "effective session state could not be verified";
  }
  if (storedSession.value !== currentSession.value) return "effective tools or session state changed";
  const storedSkills = canonicalizeIdentity(stored.skills);
  const currentSkills = canonicalizeIdentity(current.skills);
  if (storedSkills.kind === "unverifiable" || currentSkills.kind === "unverifiable") {
    return "resolved skills could not be verified";
  }
  if (storedSkills.value !== currentSkills.value) return "resolved skills changed";
  return undefined;
}

export function isAgentResumeContext(value: unknown): value is AgentResumeContext {
  if (!isRecord(value)) return false;
  return (
    isVerifiedRepositoryResumeContext(value.repository) &&
    isVerifiedWorkflowResumeContext(value.workflow) &&
    isEffectiveAgentSessionIdentity(value.session) &&
    Array.isArray(value.skills) &&
    value.skills.every(isResolvedSkillIdentity)
  );
}

async function runGit(cwd: string, args: readonly string[], signal: AbortSignal | undefined): Promise<BoundedProcessResult> {
  return await runBoundedProcess({
    file: "git",
    args,
    cwd,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_DIFF_OPTS: "" },
    signal,
    timeoutMs: GIT_CONTEXT_TIMEOUT_MS,
    maxBufferBytes: GIT_CONTEXT_MAX_BYTES,
    abortError: "git resume-context capture aborted",
    timeoutError: `git resume-context capture timed out after ${GIT_CONTEXT_TIMEOUT_MS}ms`,
    maxBufferError: `git resume-context capture exceeded ${GIT_CONTEXT_MAX_BYTES} bytes`,
    exitError: (stderr, code, exitSignal) => stderr.trim() || `git exited with code ${code ?? `signal ${exitSignal ?? "unknown"}`}`,
  });
}

type GitControlPathResult =
  | { readonly kind: "present" | "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

async function findGitControlPath(cwd: string, signal: AbortSignal | undefined): Promise<GitControlPathResult> {
  let current = resolve(cwd);
  while (true) {
    throwIfAborted(signal);
    try {
      await lstat(join(current, ".git"));
      return { kind: "present" };
    } catch (error) {
      if (!isMissingPathError(error)) {
        return { kind: "unknown", reason: `git control-path probe failed: ${unknownErrorMessage(error)}` };
      }
    }
    const parent = dirname(current);
    if (parent === current) return { kind: "absent" };
    current = parent;
  }
}

function processFailureReason(operation: string, result: BoundedProcessFailureResult): string {
  if (result.failure.kind === "exit") {
    const termination = result.failure.code === null ? `signal ${result.failure.signal ?? "unknown"}` : `exit ${result.failure.code}`;
    const message = sanitizeProcessMessage(result.failure.message);
    return `${operation} failed (${termination}${message ? `: ${message}` : ""})`;
  }
  return `${operation} failed (${result.failure.kind}: ${result.failure.message})`;
}

function isVerifiedRepositoryResumeContext(value: unknown): value is VerifiedRepositoryResumeContext {
  if (!isRecord(value)) return false;
  if (value.kind !== "verified" || typeof value.workingTreeFingerprint !== "string") return false;
  if (value.state === "git" || value.state === "isolated") return typeof value.head === "string";
  return value.state === "unborn" || value.state === "non-git" || value.state === "inaccessible";
}

function isVerifiedWorkflowResumeContext(value: unknown): value is VerifiedWorkflowResumeContext {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  return value.kind === "verified" && typeof value.sourceFingerprint === "string";
}

function isResolvedSkillIdentity(value: unknown): value is ResolvedSkillIdentity {
  return isRecord(value) && typeof value.name === "string" && typeof value.path === "string" && typeof value.fingerprint === "string";
}

function isEffectiveAgentSessionIdentity(value: unknown): value is EffectiveAgentSessionIdentity {
  if (
    !isRecord(value) ||
    typeof value.fingerprint !== "string" ||
    typeof value.runtimeVersion !== "string" ||
    typeof value.systemPromptFingerprint !== "string" ||
    typeof value.thinkingLevel !== "string" ||
    !isRecord(value.model) ||
    typeof value.model.provider !== "string" ||
    typeof value.model.id !== "string" ||
    !Array.isArray(value.tools)
  ) {
    return false;
  }
  return value.tools.every(isEffectiveToolIdentity);
}

function isEffectiveToolIdentity(value: unknown): value is EffectiveToolIdentity {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.definitionFingerprint !== "string" ||
    typeof value.implementationFingerprint !== "string" ||
    !isRecord(value.source)
  ) {
    return false;
  }
  return (
    typeof value.source.path === "string" &&
    typeof value.source.source === "string" &&
    typeof value.source.scope === "string" &&
    typeof value.source.origin === "string" &&
    typeof value.source.fingerprint === "string" &&
    (value.source.baseDir === undefined || typeof value.source.baseDir === "string")
  );
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function parseNullTerminatedRecords(output: string, operation: string): string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error(`${operation} returned unterminated data`);
  return output.slice(0, -1).split("\0");
}

function parseGitTopLevel(output: string, cwd: string): string | undefined {
  const withoutLf = output.endsWith("\n") ? output.slice(0, -1) : output;
  const value = withoutLf.endsWith("\r") ? withoutLf.slice(0, -1) : withoutLf;
  if (value.length === 0 || value.includes("\n") || value.includes("\0")) return undefined;
  const root = resolve(cwd, value);
  return isPathWithin(root, cwd) ? root : undefined;
}

function isGitObjectId(value: string): boolean {
  return /^[0-9a-f]{40,64}$/i.test(value);
}

function isFingerprintExcludedPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  for (const excluded of FINGERPRINT_EXCLUDED_RELATIVE_PATHS) {
    if (
      normalized === excluded ||
      normalized.startsWith(`${excluded}/`) ||
      normalized.endsWith(`/${excluded}`) ||
      normalized.includes(`/${excluded}/`)
    ) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeProcessMessage(message: string): string {
  return message.trim().replace(/\s+/g, " ").slice(0, 500);
}
