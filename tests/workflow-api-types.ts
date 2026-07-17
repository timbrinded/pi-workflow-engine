import { Type } from "typebox";
import type { WorkflowApi } from "../.pi/extensions/pi-workflow-engine/src/types.ts";

declare const api: WorkflowApi;

const Schema = Type.Object({ ok: Type.Boolean() });

const textResult: Promise<string> = api.agent("text");
const structuredResult: Promise<{ ok: boolean } | null> = api.agent("structured", { schema: Schema });
const isolatedTextResult: Promise<{ result: string; patch: string; changed: boolean }> = api.agent("isolated text", {
  isolation: "worktree",
});
const isolatedStructuredResult: Promise<{ result: { ok: boolean } | null; patch: string; changed: boolean }> = api.agent(
  "isolated structured",
  { isolation: "worktree", schema: Schema },
);

void textResult;
void structuredResult;
void isolatedTextResult;
void isolatedStructuredResult;

// @ts-expect-error Worktree isolation returns a patch wrapper, not plain text.
const invalidIsolatedText: Promise<string> = api.agent("isolated", { isolation: "worktree" });
void invalidIsolatedText;
