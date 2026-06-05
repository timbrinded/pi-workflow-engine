import assert from "node:assert/strict";
import { test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  appendDynamaxContextReminder,
  appendDynamaxSystemReminder,
  clearDynamax,
  consumeDynamaxOneShot,
  createDynamaxState,
  hasDynamaxToken,
  isDynamaxActive,
  markDynamaxOneShot,
  setDynamaxSticky,
} from "../.pi/extensions/pi-workflow-engine/src/dynamax.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("hasDynamaxToken matches exact dynamax word case-insensitively", () => {
  assert.equal(hasDynamaxToken("dynamax this"), true);
  assert.equal(hasDynamaxToken("please DYNAMAX!"), true);
  assert.equal(hasDynamaxToken("(dynamax)"), true);
  assert.equal(hasDynamaxToken("notdynamax"), false);
  assert.equal(hasDynamaxToken("dynamaxing"), false);
});

test("dynamax one-shot state is consumed by system reminder", () => {
  const state = createDynamaxState();
  markDynamaxOneShot(state);

  const prompted = appendDynamaxSystemReminder("base", state);

  assert.match(prompted, /dynamax workflow opt-in/);
  assert.equal(state.oneShotPending, false);
  assert.equal(appendDynamaxSystemReminder("base", state), "base");
});

test("dynamax sticky mode remains active until cleared", () => {
  const state = createDynamaxState();
  setDynamaxSticky(state, true);

  assert.equal(isDynamaxActive(state), true);
  assert.match(appendDynamaxSystemReminder("base", state), /workflow tool is permitted/);
  assert.equal(state.sticky, true);
  assert.equal(isDynamaxActive(state), true);

  clearDynamax(state);
  assert.equal(isDynamaxActive(state), false);
});

test("consumeDynamaxOneShot reports and clears pending opt-in", () => {
  const state = createDynamaxState();
  markDynamaxOneShot(state);

  assert.equal(consumeDynamaxOneShot(state), true);
  assert.equal(consumeDynamaxOneShot(state), false);
});

test("appendDynamaxContextReminder appends a hidden custom message only when sticky", () => {
  const state = createDynamaxState();
  const messages: AgentMessage[] = [];

  assert.equal(appendDynamaxContextReminder(messages, state), messages);

  setDynamaxSticky(state, true);
  const appended = appendDynamaxContextReminder(messages, state);
  assert.equal(appended.length, 1);
  const reminder = appended[0];
  assert.equal(isRecord(reminder) ? reminder.role : undefined, "custom");
  assert.equal(isRecord(reminder) ? reminder.customType : undefined, "workflow-dynamax-reminder");
  assert.equal(isRecord(reminder) ? reminder.display : undefined, false);
});
