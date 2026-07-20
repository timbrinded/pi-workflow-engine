import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "bun:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { assertSupportedPiVersion } from "../.pi/extensions/pi-workflow-engine/src/pi-compat.ts";

test("extension enforces the Pi SDK version required by its built-ins", () => {
  assert.doesNotThrow(() => assertSupportedPiVersion(VERSION));
  assert.doesNotThrow(() => assertSupportedPiVersion("0.80.10"));
  assert.doesNotThrow(() => assertSupportedPiVersion("v0.81.0-beta.1"));
  assert.throws(() => assertSupportedPiVersion("0.80.9"), /requires pi 0\.80\.10 or newer; detected "0\.80\.9"/);
  assert.throws(() => assertSupportedPiVersion("development"), /Update pi before loading this extension/);
});

test("installation docs state the minimum host Pi version", async () => {
  const [readme, usage] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("USAGE.md", "utf8"),
  ]);
  assert.match(readme, /Requires \*\*pi 0\.80\.10 or newer\*\*/);
  assert.match(usage, /requires \*\*pi 0\.80\.10 or newer\*\*/i);
});
