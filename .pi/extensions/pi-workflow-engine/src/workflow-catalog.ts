import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionKey } from "./session-identity.ts";
import type { WorkflowMeta } from "./types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";

/** System prompt section pi wraps as `<workflows>`: the registered workflows the host may run by name. */
export const WORKFLOWS_SECTION = "workflows";

/** One line per workflow, sorted by name, so the section text depends only on what is registered. */
export function formatWorkflowCatalog(workflows: Iterable<WorkflowMeta>): string | undefined {
  const lines = [...workflows]
    // Code-unit order rather than localeCompare, whose result depends on the host locale.
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((meta) => {
      const description = meta.description.trim();
      const whenToUse = meta.whenToUse?.trim();
      return `- ${meta.name}${description ? `: ${description}` : ""}${whenToUse ? ` ${whenToUse}` : ""}`;
    });
  if (lines.length === 0) return undefined;
  return [
    "Registered workflows the workflow tool runs by `name`, passing the target or instructions as `args` (only once the user opted into workflow orchestration):",
    ...lines,
  ].join("\n");
}

/**
 * The catalog section for each session, built once from discovery and then reused, so every run in
 * the session sends identical text and keeps the provider's prompt cache. A new session start rebuilds it.
 */
export class WorkflowCatalogPrompt {
  private readonly sessions = new Map<string, Promise<string | undefined>>();

  constructor(
    private readonly discover: (ctx: ExtensionContext) => Promise<Iterable<WorkflowMeta>>,
    private readonly log: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
  ) {}

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

  private async build(ctx: ExtensionContext): Promise<string | undefined> {
    try {
      return formatWorkflowCatalog(await this.discover(ctx));
    } catch (error) {
      // The catalog only advertises workflows; a discovery failure must not block the prompt.
      this.log(`[workflow] workflow catalog unavailable: ${unknownErrorMessage(error)}`);
      return undefined;
    }
  }
}
