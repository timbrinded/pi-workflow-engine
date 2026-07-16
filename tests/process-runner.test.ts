import assert from "node:assert/strict";
import { test } from "bun:test";
import { runBoundedProcess } from "../.pi/extensions/pi-workflow-engine/src/process-runner.ts";

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
