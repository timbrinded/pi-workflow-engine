import { CustomEditor, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { completeCurrentArgument } from "./command-completions.ts";
import type { DynamaxShortcuts } from "./dynamax-shortcuts.ts";
import { sessionKey } from "./session-identity.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { dot, GLYPH } from "./ui/kit.ts";
import { setWorkflowInspectorShortcut } from "./ui/workflow-widget.ts";
import {
  decorateDynamaxEditor,
  resolveDynamaxEffect,
  type DynamaxAnimationScheduler,
  type DynamaxEditorDecoration,
  type DynamaxEffect,
} from "./ui/dynamax-editor-decoration.ts";

export interface DynamaxState {
  sticky: boolean;
  oneShotPending: boolean;
  turnActive: boolean;
}

export interface DynamaxRuntime {
  state: DynamaxState;
}

export type DynamaxRuntimeStore = Map<string, DynamaxRuntime>;

export interface DynamaxRegistrationOptions {
  openInspector: (ctx: ExtensionContext) => Promise<void> | void;
  effect?: DynamaxEffect;
  animationScheduler?: DynamaxAnimationScheduler;
}

export interface DynamaxHandle {
  /** Opt the next agent run in. The `input` hook ignores prompts this extension sends (pi tags them `source: "extension"`). */
  markOneShot(ctx: ExtensionContext): void;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;
export const DYNAMAX_STATUS_KEY = "dynamax";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface DynamaxEditorInstallation {
  factory: EditorFactory;
  previousFactory: EditorFactory | undefined;
  decorations: Set<DynamaxEditorDecoration>;
}

function disposeDynamaxDecorations(decorations: Set<DynamaxEditorDecoration>): void {
  for (const decoration of decorations) decoration.dispose();
  decorations.clear();
}

const DYNAMAX_ACTION_COMPLETIONS = [
  { value: "on", description: "Keep Dynamax enabled for this session" },
  { value: "off", description: "Disable sticky and pending Dynamax modes" },
  { value: "status", description: "Show the current Dynamax state" },
] as const;

export const ADAPTIVE_WORKFLOW_GUIDANCE = `
Adaptive multi-pass workflows are optional. Use a simple single-pass fan-out when it is sufficient. When the first pass may expose gaps, conflicts, weak claims, or missing evidence:
- run the bounded first-pass agents;
- give their surviving results to a structured gap-analysis agent so the LLM decides what needs follow-up;
- put a hard maxItems bound on LLM-authored task arrays and defensively slice them before fan-out;
- use ordinary TypeScript conditionals or bounded loops to launch follow-up agents only when gaps exist;
- synthesize the first-pass and follow-up results together.
Do not generate a second pass when the first pass is sufficient, and do not invent iteration, quorum, graph, reduction, or retry primitives for this pattern.`;

/** System prompt section pi wraps as `<dynamax>`; adding or dropping it appends a section patch instead of rewriting the prompt. */
export const DYNAMAX_SECTION = "dynamax";

/** Only the opt-in itself: the authoring rules already reach the model as the workflow tool's guidelines. */
export const DYNAMAX_REMINDER =
  "The user opted into dynamax multi-agent orchestration for this request, so the workflow tool is permitted. " +
  "Run a registered workflow by name, or author an inline workflow script when none fits, following the workflow tool's guidelines.";

export function createDynamaxState(): DynamaxState {
  return { sticky: false, oneShotPending: false, turnActive: false };
}

export function createDynamaxRuntime(): DynamaxRuntime {
  return { state: createDynamaxState() };
}

export function getDynamaxRuntime(store: DynamaxRuntimeStore, ctx: Pick<ExtensionContext, "sessionManager">): DynamaxRuntime {
  const key = sessionKey(ctx);
  const existing = store.get(key);
  if (existing) return existing;
  const runtime = createDynamaxRuntime();
  store.set(key, runtime);
  return runtime;
}

export function hasDynamaxToken(text: string): boolean {
  return DYNAMAX_TOKEN_PATTERN.test(text);
}

export function markDynamaxOneShot(state: DynamaxState): void {
  state.oneShotPending = true;
}

export function enableDynamaxSticky(state: DynamaxState): void {
  state.sticky = true;
}

export function clearDynamax(state: DynamaxState): void {
  state.sticky = false;
  state.oneShotPending = false;
  state.turnActive = false;
}

export function isDynamaxActive(state: DynamaxState): boolean {
  return state.sticky || state.oneShotPending || state.turnActive;
}

export function describeDynamaxState(state: DynamaxState): string {
  const sticky = state.sticky ? "on" : "off";
  const oneShot = state.oneShotPending ? "pending" : "clear";
  const turn = state.turnActive ? "; active for current turn" : "";
  return `sticky ${sticky}; one-shot ${oneShot}${turn}`;
}

/**
 * Footer status: `◆ dynamax` while sticky, `◆ dynamax · next prompt` while a one-shot waits for its
 * prompt, `◆ dynamax · this turn` while that turn runs. A running workflow names itself in its own
 * status (`◆ repo-scan · Scan 2/3 · 4s`), so this one only states the mode.
 */
export function dynamaxStatusText(state: DynamaxState, theme: Theme): string {
  const mode = state.sticky ? undefined : state.oneShotPending ? "next prompt" : state.turnActive ? "this turn" : undefined;
  const label = `${theme.fg("accent", GLYPH.workflow)} ${theme.fg("accent", "dynamax")}`;
  return mode ? `${label}${dot(theme)}${theme.fg("muted", mode)}` : label;
}

/**
 * Add the opt-in section for this run and consume a pending one-shot. pi rebuilds `sections` for every
 * run, so an inactive run simply leaves it out and pi records the removal as a patch.
 */
export function applyDynamaxPromptSection(sections: Record<string, string>, state: DynamaxState): boolean {
  if (!state.sticky && !state.oneShotPending) return false;
  state.oneShotPending = false;
  state.turnActive = true;
  sections[DYNAMAX_SECTION] = DYNAMAX_REMINDER;
  return true;
}

export function registerDynamax(pi: ExtensionAPI, shortcuts: DynamaxShortcuts, options: DynamaxRegistrationOptions): DynamaxHandle {
  const runtimes: DynamaxRuntimeStore = new Map();
  const effect = options.effect ?? resolveDynamaxEffect();
  setWorkflowInspectorShortcut(shortcuts.inspector);
  let editorInstallation: DynamaxEditorInstallation | undefined;
  const markOneShot = (ctx: ExtensionContext): void => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    markDynamaxOneShot(runtime.state);
    updateDynamaxSurfaces(ctx, runtime);
  };
  const installEditor = (ctx: ExtensionContext): void => {
    if (ctx.mode !== "tui" || effect === "off") return;
    const previousFactory = ctx.ui.getEditorComponent();
    if (editorInstallation && editorInstallation.factory === previousFactory) return;

    const decorations = new Set<DynamaxEditorDecoration>();
    const installation: DynamaxEditorInstallation = {
      previousFactory,
      decorations,
      factory: (tui, theme, keybindings) => {
        const decorate = (editor: EditorComponent): EditorComponent => {
          const decoration = decorateDynamaxEditor(editor, () => tui.requestRender(), {
            effect,
            scheduler: options.animationScheduler,
            isActive: () => editorInstallation === installation && ctx.ui.getEditorComponent() === installation.factory,
          });
          decorations.add(decoration);
          return decoration.editor;
        };
        if (!previousFactory) return decorate(new CustomEditor(tui, theme, keybindings));

        let editor: EditorComponent;
        try {
          editor = previousFactory(tui, theme, keybindings);
        } catch (error) {
          ctx.ui.notify(
            `Dynamax could not compose the existing custom editor (${unknownErrorMessage(error)}); using pi's stock-compatible CustomEditor so highlighting stays enabled`,
            "warning",
          );
          installation.previousFactory = undefined;
          return decorate(new CustomEditor(tui, theme, keybindings));
        }

        try {
          return decorate(editor);
        } catch (error) {
          ctx.ui.notify(
            `Dynamax could not decorate the existing custom editor (${unknownErrorMessage(error)}); using pi's stock-compatible CustomEditor so highlighting stays enabled`,
            "warning",
          );
          return decorate(new CustomEditor(tui, theme, keybindings));
        }
      },
    };

    try {
      ctx.ui.setEditorComponent(installation.factory);
    } catch (error) {
      disposeDynamaxDecorations(decorations);
      ctx.ui.notify(`Dynamax highlighting could not be installed: ${unknownErrorMessage(error)}`, "error");
      throw error;
    }
    editorInstallation = installation;
  };
  const uninstallEditor = (ctx: ExtensionContext): void => {
    const installation = editorInstallation;
    if (!installation) return;
    editorInstallation = undefined;
    disposeDynamaxDecorations(installation.decorations);
    if (ctx.mode === "tui" && ctx.ui.getEditorComponent() === installation.factory) {
      ctx.ui.setEditorComponent(installation.previousFactory);
    }
  };

  pi.on("session_start", (_event, ctx) => {
    installEditor(ctx);
    updateDynamaxSurfaces(ctx, getDynamaxRuntime(runtimes, ctx));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    uninstallEditor(ctx);
    clearDynamaxSurfaces(ctx);
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && hasDynamaxToken(event.text)) markOneShot(ctx);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (applyDynamaxPromptSection(event.systemPromptOptions.sections, runtime.state)) updateDynamaxSurfaces(ctx, runtime);
  });

  pi.on("agent_end", (_event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (!runtime.state.sticky) runtime.state.turnActive = false;
    updateDynamaxSurfaces(ctx, runtime);
  });

  if (shortcuts.inspector) {
    pi.registerShortcut(shortcuts.inspector, {
      description: "Open workflow inspector",
      handler: async (ctx) => {
        await options.openInspector(ctx);
      },
    });
  }

  pi.registerCommand("workflow:dynamax", {
    description: "Toggle Dynamax workflow orchestration: /workflow:dynamax [on|off|status]",
    getArgumentCompletions: (argumentPrefix) => completeCurrentArgument(argumentPrefix, DYNAMAX_ACTION_COMPLETIONS),
    handler: async (args, ctx) => {
      const runtime = getDynamaxRuntime(runtimes, ctx);
      const action = args.trim().toLowerCase();
      if (action === "") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}. Usage: /workflow:dynamax [on|off|status]`, "info");
        return;
      }
      if (action === "on") {
        enableDynamaxSticky(runtime.state);
        updateDynamaxSurfaces(ctx, runtime);
        ctx.ui.notify("Dynamax workflow orchestration is on for this session", "info");
        return;
      }
      if (action === "off") {
        clearDynamax(runtime.state);
        updateDynamaxSurfaces(ctx, runtime);
        ctx.ui.notify("Dynamax workflow orchestration is off", "info");
        return;
      }
      if (action === "status") {
        ctx.ui.notify(`Dynamax ${describeDynamaxState(runtime.state)}`, "info");
        return;
      }
      ctx.ui.notify("Usage: /workflow:dynamax [on|off|status]", "warning");
    },
  });

  return { markOneShot };
}

export function updateDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">, runtime: DynamaxRuntime): void {
  if (!ctx.hasUI) return;
  if (!isDynamaxActive(runtime.state)) {
    clearDynamaxSurfaces(ctx);
    return;
  }
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, dynamaxStatusText(runtime.state, ctx.ui.theme));
}

export function clearDynamaxSurfaces(ctx: Pick<ExtensionContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(DYNAMAX_STATUS_KEY, undefined);
}
