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

// Arguments arrive as text and verbatim; a sub-workflow takes a name or a script file and any JSON input.
const argsText: string = api.args;
const input: unknown = api.input;
void argsText;
void input;
void api.workflow("code-review", "HEAD~3");
void api.workflow("research", { question: "q", sources: ["docs"] });
void api.workflow({ scriptPath: "scripts/audit.js" });
// @ts-expect-error A script reference names its file as `scriptPath`.
void api.workflow({ path: "scripts/audit.js" });
