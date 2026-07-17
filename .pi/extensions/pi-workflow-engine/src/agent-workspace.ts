import type { AgentExecutionOptions, RunContext } from "./agent-runner-types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

interface AgentWorkspaceBase {
  readonly cwd: string;
  wrapResult(result: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface SharedAgentWorkspace extends AgentWorkspaceBase {
  readonly kind: "shared";
}

export interface IsolatedAgentWorkspace extends AgentWorkspaceBase {
  readonly kind: "isolated";
  readonly baselineOid: string;
}

export type AgentWorkspace = SharedAgentWorkspace | IsolatedAgentWorkspace;

export async function createAgentWorkspace(
  rc: RunContext,
  opts: AgentExecutionOptions,
  label: string,
): Promise<AgentWorkspace> {
  if (opts.isolation !== "worktree") {
    return {
      kind: "shared",
      cwd: rc.cwd,
      async wrapResult(result) {
        return result;
      },
      async dispose() {},
    };
  }

  const probe = await rc.worktrees.probe(rc.signal);
  if (!probe.ok) {
    throw new Error(`Failed to check git worktree availability for isolated agent: ${probe.error ?? "unknown git error"}`);
  }
  if (!probe.inside) {
    throw new Error("Agent requested worktree isolation, but the workflow cwd is not inside a git work tree.");
  }

  const added = await rc.worktrees.add(rc.signal, opts.worktreeBaseline);
  if ("error" in added) throw new Error(`Failed to create isolated worktree: ${added.error}`);
  const worktreePath = added.path;
  rc.progress.log(`${label}: using isolated worktree ${worktreePath}`);

  return {
    kind: "isolated",
    cwd: worktreePath,
    baselineOid: added.baselineOid,
    async wrapResult(result) {
      const patch = await rc.worktrees.capturePatch(worktreePath, added.baselineOid, rc.signal);
      if ("error" in patch) throw new Error(`Failed to capture isolated worktree patch: ${patch.error}`);
      return { result, patch: patch.patch, changed: patch.changed };
    },
    async dispose() {
      const removed = await rc.worktrees.remove(worktreePath);
      if (!removed.ok) {
        rc.progress.log(
          `${label}: failed to remove isolated worktree (${removed.error ?? (removed.stderr.trim() || "unknown error")})`,
        );
      }
    },
  };
}

export async function disposeAgentWorkspace(
  rc: RunContext,
  label: string,
  workspace: AgentWorkspace | undefined,
): Promise<void> {
  if (!workspace) return;
  try {
    await workspace.dispose();
  } catch (error) {
    rc.progress.log(`${label}: failed to dispose isolated workspace (${unknownErrorMessage(error)})`);
  }
}
