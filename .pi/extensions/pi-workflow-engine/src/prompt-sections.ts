import type { BeforeAgentStartEventResult, NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

type PromptSectionOptions = Pick<NormalizedBuildSystemPromptOptions, "sections" | "forceSystemPrompt">;

/**
 * Finish adding the `name` section from a `before_agent_start` handler. Normally the section in
 * `options.sections` is enough and pi appends it as a patch. An earlier handler that forced the whole
 * prompt makes pi render no sections, so the section is appended to that text instead; pi hands the
 * returned prompt to later handlers as their `forceSystemPrompt`, so several sections chain.
 */
export function appendSectionToForcedPrompt(options: PromptSectionOptions, name: string): BeforeAgentStartEventResult | undefined {
  const text = options.sections[name];
  if (options.forceSystemPrompt === undefined || text === undefined) return undefined;
  return { systemPrompt: `${options.forceSystemPrompt}\n\n<${name}>\n${text}\n</${name}>` };
}
