import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "./session-identity.ts";
import type { WorkflowMeta } from "./types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { DEFAULT_WORKFLOW_SIZE_GUIDELINE, workflowSizeGuidelineLine, type WorkflowSizeGuideline } from "./workflow-settings.ts";

/** System prompt section pi wraps as `<workflows>`: the registered workflows the host may run by name. */
export const WORKFLOWS_SECTION = "workflows";

/**
 * One line per workflow, sorted by name, then the size guideline, so the section text depends only on
 * what is registered and configured.
 */
export function formatWorkflowCatalog(workflows: Iterable<WorkflowMeta>, sizeLine?: string): string | undefined {
  const lines = [...workflows]
    // Code-unit order rather than localeCompare, whose result depends on the host locale.
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((meta) => {
      const description = meta.description.trim();
      const whenToUse = meta.whenToUse?.trim();
      return `- ${meta.name}${description ? `: ${description}` : ""}${whenToUse ? ` ${whenToUse}` : ""}`;
    });
  const parts = lines.length === 0
    ? []
    : [
        "Registered workflows the workflow tool runs by `name`, passing the target or instructions as `args` (only once the user opted into workflow orchestration):",
        ...lines,
      ];
  if (sizeLine) parts.push(...(parts.length > 0 ? ["", sizeLine] : [sizeLine]));
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export interface WorkflowCatalogSources {
  readonly discover: (ctx: ExtensionContext) => Promise<Iterable<WorkflowMeta>>;
  readonly size: (ctx: ExtensionContext) => WorkflowSizeGuideline;
  readonly log?: (message: string) => void;
}

/**
 * The catalog section for each session, built once from discovery and settings and then reused, so every
 * run in the session sends identical text and keeps the provider's prompt cache. A new session start or a
 * size change rebuilds it.
 */
export class WorkflowCatalogPrompt {
  private readonly sessions = new Map<string, Promise<string | undefined>>();
  private readonly log: (message: string) => void;

  constructor(private readonly sources: WorkflowCatalogSources) {
    this.log = sources.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  section(ctx: ExtensionContext): Promise<string | undefined> {
    const key = sessionKey(ctx);
    const cached = this.sessions.get(key);
    if (cached) return cached;
    const built = this.build(ctx);
    this.sessions.set(key, built);
    return built;
  }

  forget(ctx: Pick<ExtensionContext, "sessionManager">): void {
    this.sessions.delete(sessionKey(ctx));
  }

  // The catalog only advertises workflows and a guideline; neither failure may block the prompt.
  private async build(ctx: ExtensionContext): Promise<string | undefined> {
    let size = DEFAULT_WORKFLOW_SIZE_GUIDELINE;
    try {
      size = this.sources.size(ctx);
    } catch (error) {
      this.log(`[workflow] workflow size guideline unavailable, using ${size}: ${unknownErrorMessage(error)}`);
    }
    let workflows: Iterable<WorkflowMeta> = [];
    try {
      workflows = await this.sources.discover(ctx);
    } catch (error) {
      this.log(`[workflow] workflow catalog unavailable: ${unknownErrorMessage(error)}`);
    }
    return formatWorkflowCatalog(workflows, workflowSizeGuidelineLine(size));
  }
}
