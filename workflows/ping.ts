import { Type } from "typebox";
import type { WorkflowApi, WorkflowMeta } from "../src/types.ts";

/** Minimal engine smoke test: a single structured-output agent call. Fast + cheap. */
export const meta: WorkflowMeta = {
  name: "ping",
  description: "Engine smoke test — one structured agent call, no tools.",
  phases: [{ title: "Ping" }],
};

export default async function run(api: WorkflowApi): Promise<unknown> {
  const { agent, phase, log } = api;
  phase("Ping");
  log("calling one structured agent");
  const result = await agent(
    "You are a code-review workflow engine. Return a one-word headline and a one-sentence summary of what you do.",
    {
      phase: "Ping",
      label: "ping",
      tools: [],
      schema: Type.Object({
        headline: Type.String({ description: "One word" }),
        summary: Type.String({ description: "One sentence" }),
      }),
    },
  );
  return result ?? { headline: "none", summary: "no structured answer returned" };
}
