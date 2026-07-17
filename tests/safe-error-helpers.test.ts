import assert from "node:assert/strict";
import { test } from "bun:test";
import { isMissingPathError } from "../.pi/extensions/pi-workflow-engine/src/filesystem-error.ts";
import { unknownErrorMessage } from "../.pi/extensions/pi-workflow-engine/src/unknown-error.ts";

test("unknownErrorMessage tolerates hostile message access and string coercion", () => {
  const hostileError = new Error("hidden");
  Object.defineProperty(hostileError, "message", {
    get(): never {
      throw new Error("message getter failed");
    },
  });
  const hostileValue = {
    toString(): never {
      throw new Error("coercion failed");
    },
  };

  assert.equal(unknownErrorMessage(hostileError), "unknown error");
  assert.equal(unknownErrorMessage(hostileValue), "unknown error");
  assert.equal(unknownErrorMessage("plain failure"), "plain failure");
});

test("isMissingPathError recognizes only ENOENT errors", () => {
  assert.equal(isMissingPathError(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(isMissingPathError(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isMissingPathError({ code: "ENOENT" }), false);
});
