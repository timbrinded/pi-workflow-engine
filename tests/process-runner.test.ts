import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  runBoundedProcess,
  type ProcessRunnerDependencies,
  type WindowsTaskkillResult,
} from "../.pi/extensions/pi-workflow-engine/src/process-runner.ts";

function processOptions(script: string) {
  return {
    file: process.execPath,
    args: ["-e", script],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    abortError: "aborted",
    timeoutError: "timed out",
    exitError: (stderr: string, code: number | null, signal: NodeJS.Signals | null) =>
      stderr.trim() || `exit ${code ?? signal ?? "unknown"}`,
  } as const;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`process ${pid} remained alive`);
}

function simulatedWindowsDependencies(
  runWindowsTaskkill: (pid: number, complete: (result: WindowsTaskkillResult) => void) => void,
  onDirectKill: ProcessRunnerDependencies["killChild"],
): ProcessRunnerDependencies {
  return { platform: "win32", runWindowsTaskkill, killChild: onDirectKill };
}

test("runBoundedProcess retains structured exit metadata", async () => {
  const result = await runBoundedProcess(processOptions('process.stderr.write("expected failure"); process.exit(7)'));

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the process to fail");
  assert.deepEqual(result.failure, {
    kind: "exit",
    message: "expected failure",
    code: 7,
    signal: null,
  });
  assert.equal(result.error, "expected failure");
});

test("runBoundedProcess distinguishes output-limit termination from child exit", async () => {
  const result = await runBoundedProcess({
    ...processOptions('process.stdout.write("too much output")'),
    maxBufferBytes: 3,
    maxBufferError: "output limit",
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the process to fail");
  assert.equal(result.failure.kind, "max-buffer");
  assert.equal(result.failure.message, "output limit");
});

test("runBoundedProcess applies one output limit across stderr and stdout", async () => {
  const result = await runBoundedProcess({
    ...processOptions('process.stderr.write("too much stderr")'),
    maxBufferBytes: 3,
    maxBufferError: "combined output limit",
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the process to fail");
  assert.equal(result.failure.kind, "max-buffer");
  assert.equal(result.failure.message, "combined output limit");
  assert.ok(result.bytes > 3);
});

test("runBoundedProcess waits for a force-killed child to close", async () => {
  const result = await runBoundedProcess({
    ...processOptions(
      'process.stdout.write(String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000)',
    ),
    timeoutMs: 100,
    killGraceMs: 5,
  });

  assert.equal(result.ok, false);
  const pid = Number(result.stdout);
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(
    () => process.kill(pid, 0),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH",
  );
});

test("runBoundedProcess falls back when taskkill exits unsuccessfully", async () => {
  let directKills = 0;
  const result = await runBoundedProcess(
    {
      ...processOptions('process.stdout.write(String(process.pid)); setInterval(() => {}, 1_000)'),
      timeoutMs: 50,
      killGraceMs: 100,
    },
    simulatedWindowsDependencies(
      (_pid, complete) => complete({ ok: false, reason: "taskkill exited with code 5" }),
      (child, signal) => {
        directKills += 1;
        return child.kill(signal);
      },
    ),
  );

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the process to time out");
  assert.equal(result.failure.kind, "timeout");
  assert.equal(result.termination, undefined);
  assert.equal(directKills, 1);
});

test("runBoundedProcess trusts successful taskkill only after child closure", async () => {
  let directKills = 0;
  const result = await runBoundedProcess(
    {
      ...processOptions('process.stdout.write(String(process.pid)); setInterval(() => {}, 1_000)'),
      timeoutMs: 50,
      killGraceMs: 100,
    },
    simulatedWindowsDependencies(
      (pid, complete) => {
        process.kill(pid, "SIGKILL");
        complete({ ok: true });
      },
      (child, signal) => {
        directKills += 1;
        return child.kill(signal);
      },
    ),
  );

  assert.equal(result.ok, false);
  assert.equal(result.termination, undefined);
  assert.equal(directKills, 0);
  await assertProcessGone(Number(result.stdout));
});

test("runBoundedProcess reports unconfirmed Windows termination after the final bound", async () => {
  let pid = 0;
  try {
    const result = await runBoundedProcess(
      {
        ...processOptions('process.stdout.write(String(process.pid)); setInterval(() => {}, 1_000)'),
        timeoutMs: 50,
        killGraceMs: 10,
      },
      simulatedWindowsDependencies(
        (childPid, complete) => {
          pid = childPid;
          complete({ ok: false, reason: "taskkill exited with code 5" });
        },
        () => false,
      ),
    );

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected the process to time out");
    assert.equal(result.failure.kind, "timeout");
    assert.deepEqual(result.termination, {
      status: "unconfirmed",
      reason: "taskkill exited with code 5; direct-child termination was not accepted; child did not close within the termination grace period",
    });
    assert.ok(pid > 0);
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The child may have exited independently.
      }
      await assertProcessGone(pid);
    }
  }
});

test("runBoundedProcess terminates a descendant that retains inherited stdio", async () => {
  if (process.platform === "win32") return;
  const result = await runBoundedProcess({
    ...processOptions(""),
    file: "sh",
    args: ["-c", 'sleep 30 & printf "%s\\n" "$!"; exit 0'],
    timeoutMs: 50,
    killGraceMs: 20,
  });

  assert.equal(result.ok, false);
  if (result.ok) assert.fail("expected the process to time out");
  assert.equal(result.failure.kind, "timeout");
  assert.ok(result.durationMs < 1_000, `process settled after ${result.durationMs}ms`);
  const descendantPid = Number(result.stdout.trim());
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  await assertProcessGone(descendantPid);
});

test("runBoundedProcess preserves the first terminal failure", async () => {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(new Error("late abort")), 100);
  try {
    const result = await runBoundedProcess({
      ...processOptions('process.on("SIGTERM", () => {}); process.stdout.write("too much output"); setInterval(() => {}, 1_000)'),
      signal: controller.signal,
      timeoutMs: 150,
      killGraceMs: 200,
      maxBufferBytes: 3,
      maxBufferError: "first output failure",
    });

    assert.equal(result.ok, false);
    if (result.ok) assert.fail("expected the process to fail");
    assert.deepEqual(result.failure, { kind: "max-buffer", message: "first output failure" });
  } finally {
    clearTimeout(abortTimer);
  }
});
