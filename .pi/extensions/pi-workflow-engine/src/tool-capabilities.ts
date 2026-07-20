import type { AgentToolHint } from "./types.ts";
import type { AgentRunnerToolInfo } from "./agent-runner-types.ts";

/** Raised before prompting when required semantic tool capabilities are unavailable. */
export class WorkflowToolHintUnavailableError extends Error {
  readonly code = "WORKFLOW_TOOL_HINT_UNAVAILABLE";
  readonly hints: readonly AgentToolHint[];

  constructor(hints: readonly AgentToolHint[]) {
    super(`Required workflow tool capability unavailable: ${hints.join(", ")}`);
    this.name = "WorkflowToolHintUnavailableError";
    this.hints = [...hints];
  }
}

export function matchesAgentToolHint(tool: AgentRunnerToolInfo, hint: AgentToolHint): boolean {
  return hint === "search" ? isSearchLikeTool(tool) : isExternalSearchLikeTool(tool);
}

export function isExternalSearchLikeTool(tool: AgentRunnerToolInfo): boolean {
  if (isMutationLikeToolName(tool.name) || tool.sourceInfo?.source === "builtin") return false;
  const name = tool.name.toLowerCase();
  const description = [tool.description, ...(tool.promptGuidelines ?? [])].join(" ").toLowerCase();
  const text = `${name} ${description}`;
  const hasResearchAction = /\b(?:browse|browser|search|fetch|extract|open|read|get)\b/.test(text)
    || /(?:^|[-_])(?:browse|browser|search|fetch|extract)(?:$|[-_])/.test(name)
    || /(?:^|[^a-z0-9])web(?:$|[^a-z0-9])/.test(name);
  const hasExternalMedium = /(?:^|[-_])(?:web|browser|url|http|https|tavily|exa|firecrawl|brave|serper|parallel|perplexity)(?:$|[-_])/.test(name)
    || /\b(?:search|browse)\s+(?:the\s+)?(?:web|internet)\b/.test(description)
    || /\b(?:internet|web) search(?: engine)?\b/.test(description)
    || /\b(?:fetch|extract|open|read|get)\s+(?:(?:the|a|an)\s+)?(?:url|web\s?page|website|https? page)\b/.test(description);
  return hasResearchAction && hasExternalMedium;
}

function isSearchLikeTool(tool: AgentRunnerToolInfo): boolean {
  if (isMutationLikeToolName(tool.name)) return false;
  const name = tool.name.toLowerCase();
  if (name.includes("grep") || name.includes("find") || name.includes("search") || name === "rg" || name.includes("ripgrep")) return true;
  return /\b(?:grep|find|search|ripgrep|rg|structural search|code search)\b/.test(tool.description?.toLowerCase() ?? "");
}

function isMutationLikeToolName(name: string): boolean {
  return /(?:edit|write|replace|patch|apply|delete|remove|move|rename|create|commit|push)/.test(name.toLowerCase());
}
