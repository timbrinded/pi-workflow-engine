import assert from "node:assert/strict";
import { test } from "bun:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { validateCandidatePatch, type PatchEvaluation } from "../.pi/extensions/pi-workflow-engine/src/review/patch-validation.ts";
import { fingerprintReviewWorktreeBaseline } from "../.pi/extensions/pi-workflow-engine/src/review/review-snapshot.ts";
import { runReviewFixWorkflow } from "../.pi/extensions/pi-workflow-engine/src/review/review-fix-workflow.ts";
import { createAgentWorkspace } from "../.pi/extensions/pi-workflow-engine/src/agent-workspace.ts";
import { WorktreeRegistry, captureWorktreePatch } from "../.pi/extensions/pi-workflow-engine/src/worktree.ts";
import { bindParallel } from "../.pi/extensions/pi-workflow-engine/src/concurrency.ts";
import { toReviewIssues } from "../.pi/extensions/pi-workflow-engine/src/review/review-issues.ts";
import type { AgentOptions, WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "patch-validation-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  git("init", "-q");
  await writeFile(join(cwd, "value.txt"), "broken\n");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "baseline");
  const baseline = { ref: git("rev-parse", "HEAD") };
  await writeFile(join(cwd, "value.txt"), "fixed\n");
  const captured = await captureWorktreePatch({ worktreePath: cwd, baselineOid: baseline.ref });
  assert.ok(!("error" in captured));
  git("restore", "value.txt");
  return { cwd, baseline, expectedFingerprint: fingerprintReviewWorktreeBaseline(baseline), baselineOid: baseline.ref, patch: captured.patch,
    cleanup: () => rm(cwd, { recursive: true, force: true }) };
}
const check = { file: process.execPath, args: ["-e", "const fs = require('node:fs'); if(fs.readFileSync('value.txt','utf8') !== 'fixed\\n') { console.error('value remains broken'); process.exit(1); }"], required: true };
const accepted: PatchEvaluation = { outcome: "accepted", reason: "Repair addresses the condition", checks: [check] };

for (const scenario of ["verified", "rejected", "blocked", "stale", "wrong-baseline", "no-patch"] as const) {
  test(`candidate validation: ${scenario}`, async () => {
    const repo = await fixture();
    try {
      const evaluation: PatchEvaluation = scenario === "rejected" ? { ...accepted, checks: [{ ...check, args: ["-e", "console.error('regression'); process.exit(1)"] }] }
        : scenario === "blocked" ? { ...accepted, checks: [check, { ...check, file: "unavailable-validation-tool-123" }] } : accepted;
      const result = await validateCandidatePatch({ ...repo, evaluation,
        ...(scenario === "stale" ? { expectedFingerprint: "stale" } : {}),
        ...(scenario === "wrong-baseline" ? { baselineOid: "b".repeat(40) } : {}),
        ...(scenario === "no-patch" ? { patch: "" } : {}),
      });
      assert.equal(result.status, scenario === "stale" || scenario === "wrong-baseline" ? "rejected" : scenario);
      assert.equal(result.baselineFingerprint, repo.expectedFingerprint);
      assert.match(result.patchHash, /^[a-f0-9]{64}$/);
      if (scenario === "verified") assert.equal(result.checks[0]?.result.ok, true);
      if (scenario === "rejected") {
        assert.equal(result.checks[0]?.result.ok, false);
        assert.match(result.checks[0]?.result.stderr ?? "", /regression/);
      }
      if (scenario === "no-patch") assert.match(result.reason, /does not establish/);
      assert.equal(await readFile(join(repo.cwd, "value.txt"), "utf8"), "broken\n");
      const worktrees = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo.cwd, encoding: "utf8" });
      assert.equal((worktrees.match(/^worktree /gm) ?? []).length, 1);
    } finally { await repo.cleanup(); }
  });
}

test("regression validation observes intended baseline failure and repaired success", async () => {
  const repo = await fixture();
  try {
    const testPatch = "diff --git a/regression.txt b/regression.txt\nnew file mode 100644\n--- /dev/null\n+++ b/regression.txt\n@@ -0,0 +1 @@\n+regression fixture\n";
    const result = await validateCandidatePatch({ ...repo, evaluation: { ...accepted, checks: [{ ...check, regression: { baselinePatch: testPatch, expectedFailure: "value remains broken" } }] } });
    assert.equal(result.status, "verified");
    assert.deepEqual(result.checks.map((entry) => [entry.stage, entry.result.ok]), [["candidate", true], ["baseline", false]]);
    const invalid = await validateCandidatePatch({ ...repo, evaluation: { ...accepted, checks: [{ ...check, regression: { baselinePatch: testPatch, expectedFailure: "unrelated failure" } }] } });
    assert.equal(invalid.status, "blocked");
  } finally { await repo.cleanup(); }
});

test("blocked validation retains the baseline regression setup failure", async () => {
  const repo = await fixture();
  try {
    const result = await validateCandidatePatch({ ...repo, evaluation: {
      ...accepted, checks: [{ ...check, regression: { baselinePatch: "invalid patch", expectedFailure: "value remains broken" } }],
    } });
    assert.equal(result.status, "blocked");
    assert.match(result.reason, /Baseline regression setup failed:/);
    assert.match(result.reason, /No valid patches/);
    assert.deepEqual(result.checks.map((entry) => [entry.stage, entry.result.ok]), [["candidate", true]]);
  } finally { await repo.cleanup(); }
});

test("fix workflow uses a fresh evaluator, retains rejected patches, and cannot trust implementer success claims", async () => {
  const repo = await fixture();
  const registry = new WorktreeRegistry(repo.cwd);
  const paths: string[] = [];
  const issues = toReviewIssues("code-review", { findings: [{ summary: "Wrong value", category: "bug", severity: "high", confidence: "high", locations: [{ file: "value.txt", line: 1 }], evidence: ["broken value"], impact: "request failure", recommendation: "repair" }] });
  try {
    const agent = (async (_prompt: string, options: AgentOptions) => {
      const workspace = await createAgentWorkspace({ cwd: repo.cwd, worktrees: registry, signal: undefined, progress: { log() {} } }, { ...options, worktreeBaseline: repo.baseline }, options.label!);
      paths.push(workspace.cwd);
      try {
        if (options.label?.startsWith("fix:")) {
          await writeFile(join(workspace.cwd, "value.txt"), "fixed\n");
          return await workspace.wrapResult("VERIFIED: all checks passed (implementer claim)");
        }
        assert.equal(await readFile(join(workspace.cwd, "value.txt"), "utf8"), "fixed\n");
        assert.notEqual(workspace.cwd, paths[0]);
        return await workspace.wrapResult({ outcome: "rejected", reason: "Repair breaks a caller", checks: [check] });
      } finally { await workspace.dispose(); }
    }) as WorkflowApi["agent"];
    const result = await runReviewFixWorkflow({ agent, parallel: bindParallel({}), phase() {}, signal: undefined, cwd: repo.cwd }, issues,
      { workflowName: "code-review", target: "", files: ["value.txt"], diffTarget: { kind: "git", args: [] }, snapshot: { baselineFingerprint: repo.expectedFingerprint, diffFingerprint: "a".repeat(64) } }, repo.baseline);
    assert.equal(paths.length, 2);
    const preview = result.fixes[0]!;
    assert.ok("patch" in preview);
    assert.equal(preview.validation.status, "rejected");
    assert.equal(preview.patch, repo.patch);
    assert.match(preview.result, /VERIFIED/);
    assert.match(result.summary, /0 verified/);
  } finally { await registry.removeAll(); await repo.cleanup(); }
});

test("evaluator setup rejects a stale candidate before starting and releases its worktree", async () => {
  const repo = await fixture();
  const registry = new WorktreeRegistry(repo.cwd);
  try {
    await assert.rejects(createAgentWorkspace({ cwd: repo.cwd, worktrees: registry, signal: undefined, progress: { log() {} } },
      { isolation: "worktree", worktreeBaseline: repo.baseline, candidatePatch: { baselineOid: "b".repeat(40), patch: repo.patch } }, "evaluator"), /baseline differs/);
    assert.equal(registry.size, 0);
  } finally { await registry.removeAll(); await repo.cleanup(); }
});

test("evaluator reconstruction includes the reviewed dirty snapshot", async () => {
  const repo = await fixture();
  const registry = new WorktreeRegistry(repo.cwd);
  try {
    const dirtyPatch = "diff --git a/reviewed.txt b/reviewed.txt\nnew file mode 100644\n--- /dev/null\n+++ b/reviewed.txt\n@@ -0,0 +1 @@\n+reviewed dirty state\n";
    const baseline = { ...repo.baseline, patch: dirtyPatch };
    const prepared = await registry.add(undefined, baseline);
    assert.ok(!("error" in prepared));
    const result = await validateCandidatePatch({ ...repo, baseline, expectedFingerprint: fingerprintReviewWorktreeBaseline(baseline), baselineOid: prepared.baselineOid,
      evaluation: { ...accepted, checks: [{ ...check, args: ["-e", "const fs=require('node:fs'); if(fs.readFileSync('value.txt','utf8') !== 'fixed\\n' || fs.readFileSync('reviewed.txt','utf8') !== 'reviewed dirty state\\n') process.exit(1)"] }] } });
    assert.equal(result.status, "verified");
    assert.equal(result.baselineOid, prepared.baselineOid);
  } finally { await registry.removeAll(); await repo.cleanup(); }
});

test("fatal evaluator cancellation aborts the fix workflow instead of becoming blocked", async () => {
  const { WorkflowAbortError } = await import("../.pi/extensions/pi-workflow-engine/src/cancellation.ts");
  const baseline = { ref: "a".repeat(40) };
  const issues = toReviewIssues("code-review", { findings: [{ summary: "bug", category: "bug", severity: "high", confidence: "high", locations: [], evidence: [], impact: "impact", recommendation: "repair" }] });
  const agent = (async (_prompt: string, options: AgentOptions) => {
    if (options.label?.startsWith("fix:")) return { result: "done", patch: "candidate", changed: true, baselineOid: baseline.ref };
    throw new WorkflowAbortError("evaluator cancelled");
  }) as WorkflowApi["agent"];
  await assert.rejects(runReviewFixWorkflow({ agent, parallel: bindParallel({}), phase() {}, signal: undefined, cwd: process.cwd() }, issues,
    { workflowName: "code-review", target: "", files: [], diffTarget: { kind: "git", args: [] }, snapshot: { baselineFingerprint: fingerprintReviewWorktreeBaseline(baseline), diffFingerprint: "a".repeat(64) } }, baseline), /evaluator cancelled/);
});

for (const status of ["verified", "rejected", "blocked"] as const) {
  test(`cleanup failure preserves ${status} validation evidence in the fix workflow`, async () => {
    const repo = await fixture();
    const evaluation: PatchEvaluation = {
      outcome: status === "blocked" ? "blocked" : "accepted",
      reason: status === "blocked" ? "Required service is unavailable" : "Independent evaluation complete",
      checks: [{
        file: process.execPath,
        args: ["-e", `require('node:child_process').execFileSync('git', ['worktree', 'lock', process.cwd()]); console.error('observed check output'); process.exit(${status === "rejected" ? 1 : 0})`],
        required: true,
      }],
    };
    const issues = toReviewIssues("code-review", { findings: [{ summary: "Wrong value", category: "bug", severity: "high", confidence: "high", locations: [], evidence: [], impact: "failure", recommendation: "repair" }] });
    const agent = (async (_prompt: string, options: AgentOptions) => ({
      result: options.label?.startsWith("fix:") ? "Implementation complete" : evaluation,
      patch: repo.patch, changed: true, baselineOid: repo.baselineOid,
    })) as WorkflowApi["agent"];
    try {
      const result = await runReviewFixWorkflow({ agent, parallel: bindParallel({}), phase() {}, cwd: repo.cwd, signal: undefined }, issues,
        { workflowName: "code-review", target: "", files: [], diffTarget: { kind: "git", args: [] }, snapshot: { baselineFingerprint: repo.expectedFingerprint, diffFingerprint: "a".repeat(64) } }, repo.baseline);
      const preview = result.fixes[0]!;
      assert.ok("patch" in preview);
      assert.equal(preview.patch, repo.patch);
      assert.equal(preview.validation.status, status === "verified" ? "blocked" : status);
      assert.deepEqual(preview.validation.evaluation, evaluation);
      assert.equal(preview.validation.checks.length, 1);
      assert.equal(preview.validation.checks[0]?.result.ok, status !== "rejected");
      assert.match(preview.validation.checks[0]?.result.stderr ?? "", /observed check output/);
      assert.match(preview.validation.cleanupError ?? "", /locked working tree/);
      assert.match(preview.validation.reason, /Cleanup failed:/);
      if (status === "blocked") assert.match(preview.validation.reason, /Required service is unavailable/);
      if (status === "rejected") assert.match(preview.validation.reason, /observed check output/);
      assert.match(result.summary, /0 verified/);
    } finally {
      await removeLockedWorktrees(repo.cwd);
      await repo.cleanup();
    }
  });
}

async function removeLockedWorktrees(cwd: string): Promise<void> {
  const list = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" });
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ") || line.slice(9) === cwd) continue;
    const path = line.slice(9);
    execFileSync("git", ["worktree", "unlock", path], { cwd });
    execFileSync("git", ["worktree", "remove", "--force", path], { cwd });
  }
}

test("cleanup failure does not replace cancellation during validation", async () => {
  const repo = await fixture();
  const controller = new AbortController();
  const cancelled = new Error("Validation cancelled by user");
  const watcher = watch(repo.cwd, (_event, filename) => {
    if (filename === "locked-marker") controller.abort(cancelled);
  });
  try {
    await assert.rejects(validateCandidatePatch({ ...repo, signal: controller.signal, evaluation: {
      ...accepted, checks: [{ file: process.execPath, required: true, args: ["-e",
        `require('node:child_process').execFileSync('git', ['worktree', 'lock', process.cwd()]); require('node:fs').writeFileSync(${JSON.stringify(join(repo.cwd, "locked-marker"))}, 'ready'); setTimeout(() => {}, 30000);`,
      ] }],
    } }), (error) => error === cancelled);
  } finally {
    watcher.close();
    await removeLockedWorktrees(repo.cwd);
    await repo.cleanup();
  }
});
