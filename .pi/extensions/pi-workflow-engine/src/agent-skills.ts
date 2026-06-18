import { DefaultResourceLoader, getAgentDir, type ResourceDiagnostic, type Skill } from "@earendil-works/pi-coding-agent";

export type AgentSkillOption = readonly string[] | undefined;
export type AgentSkillRequestSource = "explicit" | "prompt";

export interface AgentSkillRequest {
  readonly selectors: readonly string[];
  readonly source: AgentSkillRequestSource;
  readonly strict: boolean;
}

export interface AgentSkillResolution {
  readonly selected: readonly Skill[];
  readonly unmatched: readonly string[];
}

export interface AgentSkillResourceSetup {
  readonly resourceLoader: DefaultResourceLoader;
  readonly selectedSkills: readonly Skill[];
  readonly unmatchedSelectors: readonly string[];
  readonly diagnostics: readonly ResourceDiagnostic[];
}

const SLASH_SKILL_PATTERN = /\/skill:([a-z0-9][a-z0-9-]{0,63})/gi;
const SKILLS_FIELD_PATTERN = /(?<!\/)\bskills?\s*[:=]\s*([^\n.;]+)/gi;
const VERB_SKILL_LIST_PATTERN = /\b(?:include|use|enable|load|provide|allow|grant|with)\s+(?:the\s+|this\s+|these\s+)?skills?\s+([^\n.;]+)/gi;
const VERB_NAMED_SKILL_PATTERN = /\b(?:include|use|enable|load|provide|allow|grant|with)\s+(?:the\s+|this\s+|these\s+)?(["'`]?)([a-z0-9][a-z0-9 _-]{0,80}?)\1\s+skills?\b/gi;
const PURPOSE_BOUNDARY_PATTERN = /\s+\b(?:for|to|when|while|so|because|in\s+order\s+to)\b.*$/i;

/**
 * Resolve which subagent skills were requested.
 *
 * Subagents are skillless by default. Explicit `opts.skills` wins and suppresses prompt inference;
 * when it is omitted we only infer from clear natural-language opt-ins such as `/skill:name`,
 * `include skill diagnose`, `include this Skill diagnose`, or `use the diagnose skill`.
 */
export function resolveAgentSkillRequest(prompt: string, explicitSkills: AgentSkillOption): AgentSkillRequest {
  if (explicitSkills !== undefined) {
    return { selectors: uniqueSelectors(explicitSkills), source: "explicit", strict: true };
  }
  return { selectors: extractSkillSelectorsFromText(prompt), source: "prompt", strict: false };
}

export function extractSkillSelectorsFromText(text: string): string[] {
  const selectors: string[] = [];
  collectPatternMatches(text, SLASH_SKILL_PATTERN, selectors, 1);
  collectListPatternMatches(text, SKILLS_FIELD_PATTERN, selectors);
  collectListPatternMatches(text, VERB_SKILL_LIST_PATTERN, selectors);
  collectPatternMatches(text, VERB_NAMED_SKILL_PATTERN, selectors, 2);
  return uniqueSelectors(selectors);
}

export function normalizeSkillSelector(value: string): string {
  return value
    .trim()
    .replace(/^\/skill:/i, "")
    .replace(/^skills?\s*[:=]?\s*/i, "")
    .replace(/^(?:named|called)\s+/i, "")
    .replace(/^(?:the|this|these)\s+/i, "")
    .replace(/\s+skills?$/i, "")
    .replace(/^[`"']+|[`"']+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function selectAgentSkills(skills: readonly Skill[], selectors: readonly string[]): AgentSkillResolution {
  const selected = new Map<string, Skill>();
  const unmatched: string[] = [];

  for (const selector of selectors) {
    const match = matchSkillSelector(skills, selector);
    if (!match) {
      unmatched.push(selector);
      continue;
    }
    selected.set(match.name, makeSkillModelInvocable(match));
  }

  return { selected: [...selected.values()], unmatched };
}

export async function createAgentSkillResourceLoader(options: {
  readonly cwd: string;
  readonly prompt: string;
  readonly skills: AgentSkillOption;
  readonly log?: (message: string) => void;
}): Promise<AgentSkillResourceSetup> {
  const request = resolveAgentSkillRequest(options.prompt, options.skills);
  let resolution: AgentSkillResolution = { selected: [], unmatched: [] };
  let availableSkillNames: readonly string[] = [];

  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    noSkills: request.selectors.length === 0,
    skillsOverride:
      request.selectors.length === 0
        ? undefined
        : (current) => {
            availableSkillNames = current.skills.map((skill) => skill.name).sort();
            resolution = selectAgentSkills(current.skills, request.selectors);
            return { skills: [...resolution.selected], diagnostics: current.diagnostics };
          },
  });
  await loader.reload();

  if (request.strict && resolution.unmatched.length > 0) {
    throw new Error(
      `Unknown subagent skill${resolution.unmatched.length === 1 ? "" : "s"}: ${resolution.unmatched.join(", ")}. Available: ${
        availableSkillNames.join(", ") || "(none)"
      }.`,
    );
  }

  if (!request.strict && resolution.unmatched.length > 0) {
    options.log?.(`Ignoring unrecognized subagent skill mention${resolution.unmatched.length === 1 ? "" : "s"}: ${resolution.unmatched.join(", ")}`);
  }

  const { diagnostics } = loader.getSkills();
  return { resourceLoader: loader, selectedSkills: resolution.selected, unmatchedSelectors: resolution.unmatched, diagnostics };
}

export function appendSkillReminder(prompt: string, skills: readonly Pick<Skill, "name" | "filePath">[]): string {
  if (skills.length === 0) return prompt;
  const skillList = skills.map((skill) => `${skill.name} (${skill.filePath})`).join(", ");
  return `${prompt}\n\nWorkflow subagent skills enabled: ${skillList}. If you rely on an enabled skill, first read its SKILL.md with the read tool and follow its instructions. No other skills are available in this subagent.`;
}

function collectPatternMatches(text: string, pattern: RegExp, selectors: string[], captureIndex: number): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = match[captureIndex];
    if (value !== undefined) selectors.push(value);
  }
}

function collectListPatternMatches(text: string, pattern: RegExp, selectors: string[]): void {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const value = match[1];
    if (value === undefined) continue;
    selectors.push(...parseSkillList(value));
  }
}

function parseSkillList(fragment: string): string[] {
  const scoped = fragment.replace(PURPOSE_BOUNDARY_PATTERN, "");
  return scoped
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function uniqueSelectors(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeSkillSelector(value);
    if (!normalized || isGenericSkillWord(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function isGenericSkillWord(value: string): boolean {
  return value === "skill" || value === "skills" || value === "the" || value === "this" || value === "these" || value === "that";
}

function matchSkillSelector(skills: readonly Skill[], selector: string): Skill | undefined {
  const normalized = normalizeSkillSelector(selector);
  if (!normalized) return undefined;

  const exact = skills.find((skill) => skill.name.toLowerCase() === normalized);
  if (exact) return exact;

  const selectorWords = normalized.replace(/-/g, " ");
  const fuzzy = skills.filter((skill) => {
    const name = skill.name.toLowerCase();
    const words = name.replace(/-/g, " ");
    return name.includes(normalized) || words.includes(selectorWords);
  });
  return fuzzy.length === 1 ? fuzzy[0] : undefined;
}

function makeSkillModelInvocable(skill: Skill): Skill {
  return skill.disableModelInvocation ? { ...skill, disableModelInvocation: false } : skill;
}
