import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { isRecord } from "../guards.ts";
import { readInlineWorkflowMeta } from "../inline-workflow.ts";
import { GLYPH, hangingWrap, keyHints, spread } from "./kit.ts";
import { LinesComponent, shortRunId, type WorkflowResultHints } from "./result-layout.ts";
import { isWorkflowResult, workflowResultComponent } from "./workflow-result-renderer.ts";

/** The workflow tool arguments the call row reads; everything is optional while arguments stream in. */
export interface WorkflowToolCallArgs {
  readonly name?: string;
  readonly script?: string;
  readonly args?: string;
  readonly background?: boolean;
  readonly resumeFromRunId?: string;
}

export interface WorkflowToolResultView {
  readonly content: readonly ({ readonly type: "text"; readonly text: string } | { readonly type: "image" })[];
  readonly details: unknown;
}

/** A named workflow, or an inline one identified by its literal meta (`inline` until that parses). */
export function workflowToolTitle(args: WorkflowToolCallArgs): { readonly name: string; readonly detail?: string } {
  const detail = collapseWhitespace(args.args ?? "");
  const named = args.name?.trim();
  if (named) return { name: named, detail: detail || undefined };
  const meta = args.script ? readInlineWorkflowMeta(args.script) : undefined;
  return { name: meta?.name ?? "inline", detail: detail || collapseWhitespace(meta?.description ?? "") || undefined };
}

/** `▸ workflow code-review · HEAD~3 (background)`: the detail is shortened before the tags are. */
export function renderWorkflowToolCall(args: WorkflowToolCallArgs, theme: Theme): Component {
  return new LinesComponent((width) => [workflowToolCallLine(args, width, theme)]);
}

export function workflowToolCallLine(args: WorkflowToolCallArgs, width: number, theme: Theme): string {
  const { name, detail } = workflowToolTitle(args);
  const head = `▸ ${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("accent", name)}`;
  const resume = args.resumeFromRunId?.trim();
  const tags = [args.background ? "background" : undefined, resume ? `resume ${shortRunId(resume)}` : undefined].filter(Boolean);
  const tail = tags.length > 0 ? theme.fg("dim", ` (${tags.join(", ")})`) : "";
  const room = width - visibleWidth(head) - visibleWidth(tail) - 3;
  if (!detail || room < 8) return truncateToWidth(head + tail, width, "…");
  return `${head}${theme.fg("dim", " · ")}${theme.fg("muted", truncateToWidth(detail, room, "…"))}${tail}`;
}

/**
 * The tool row's result: `● running repo-scan` while the run is live, the full result renderer once it
 * returns, a one-line receipt for a background start, and the error text for a rejected call.
 */
export function renderWorkflowToolResult(
  result: WorkflowToolResultView,
  options: { readonly expanded: boolean; readonly isPartial: boolean },
  theme: Theme,
  args: WorkflowToolCallArgs,
  hints: WorkflowResultHints,
): Component {
  const details = result.details;
  if (options.isPartial) {
    // The live widget below names the inspector shortcut for the whole run.
    return new LinesComponent(() => [`${theme.fg("accent", GLYPH.running)} ${theme.fg("muted", "running")} ${theme.bold(workflowToolTitle(args).name)}`]);
  }
  if (isWorkflowResult(details)) return workflowResultComponent(details, options.expanded, theme, hints);
  if (isRecord(details) && details.background === true && typeof details.runId === "string") {
    const name = typeof details.name === "string" ? details.name : workflowToolTitle(args).name;
    const runId = details.runId;
    // A receipt, not a live status: it stays in the transcript after the run finishes.
    return new LinesComponent((width) => [
      spread(
        `${theme.fg("accent", GLYPH.workflow)} ${theme.bold(name)}  ${theme.fg("muted", "started in background")}`,
        theme.fg("dim", `run ${shortRunId(runId)}`),
        width,
      ),
      `  ${theme.fg("muted", "its result is posted here when it finishes")}${theme.fg("dim", " · ")}${keyHints([["/workflow:runs", "manage"]], theme)}`,
    ]);
  }
  const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim() || "Workflow finished.";
  const failed = isRecord(details) && typeof details.error === "string";
  const gutter = failed ? "  " : "";
  return new LinesComponent((width) => text.split("\n").flatMap((line, index) => hangingWrap(
    theme.fg(failed ? "error" : "muted", line),
    width,
    index === 0 && failed ? `${theme.fg("error", GLYPH.failed)} ` : gutter,
    gutter,
  )));
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
