import { CustomEditor, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { completeCurrentArgument } from "./command-completions.ts";
import type { DynamaxShortcuts } from "./dynamax-shortcuts.ts";
import { appendSectionToForcedPrompt } from "./prompt-sections.ts";
import { sessionKey } from "./session-identity.ts";
import { WORKFLOW_TOOL_NAME } from "./types.ts";
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

/** The output-token pool a `+500k`-style directive in the user's prompt sets for that turn's workflow runs. */
export interface DynamaxTurnBudget {
  readonly total: number;
  /** Tokens not yet spent by this turn's synchronous runs; never negative. */
  remaining(): number;
  /** Count a finished synchronous run's output tokens against the pool. */
  spend(outputTokens: number): void;
}

export interface DynamaxRuntime {
  state: DynamaxState;
  /** Set by a budget directive in a user prompt, cleared when that run settles. */
  turnBudget?: DynamaxTurnBudget;
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
  /** The current turn's output-token pool, when the user's prompt set one. */
  turnBudget(ctx: ExtensionContext): DynamaxTurnBudget | undefined;
  /** Whether Dynamax covers this session now: sticky, a pending one-shot, or a one-shot turn in progress. */
  isActive(ctx: ExtensionContext): boolean;
}

export const DYNAMAX_TOKEN_PATTERN = /(^|[^A-Za-z0-9_])dynamax([^A-Za-z0-9_]|$)/i;
/** `+500k`, `+1.5m`, `+2M`, `+250000`: after the start or whitespace, before the end, whitespace, or punctuation. */
export const BUDGET_DIRECTIVE_PATTERN = /(?:^|\s)\+(\d+(?:\.\d+)?)([km]?)(?=$|\s|[.,;:!?)\]}"'])/i;
/** Smaller values are ignored, so a `+1` or `+2` in ordinary prose never caps a run at a few tokens. */
export const BUDGET_DIRECTIVE_MIN_TOKENS = 1_000;
const BUDGET_DIRECTIVE_MULTIPLIERS: Readonly<Record<string, number>> = { "": 1, k: 1_000, m: 1_000_000 };
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

/** With no argument the command toggles sticky mode, so these name only the explicit forms. */
const DYNAMAX_ACTION_COMPLETIONS = [
  { value: "on", description: "Make workflow orchestration the default for this session" },
  { value: "off", description: "Disable sticky and pending Dynamax modes" },
  { value: "status", description: "Show the current Dynamax state" },
] as const;

/** System prompt section pi wraps as `<dynamax>`; adding or dropping it appends a section patch instead of rewriting the prompt. */
export const DYNAMAX_SECTION = "dynamax";

/**
 * Only the opt-in itself: the workflow tool's guidelines send the model to the workflow-authoring
 * skill, which carries the authoring rules and patterns.
 */
export const DYNAMAX_REMINDER =
  "The user opted into dynamax multi-agent orchestration for this request, so the workflow tool is permitted. " +
  "Run a registered workflow by name, or author an inline workflow script when none fits, following the workflow tool's guidelines.";

/** Sticky mode is a standing default for the session, not a one-request permission. */
export const DYNAMAX_STICKY_REMINDER =
  "Dynamax is on for this session. Orchestrate every substantive task with the workflow tool by default: " +
  "scout inline first to find the work list, then run one single-phase workflow per phase (understand, design, implement, review) " +
  "and read each result before choosing the next. Lean toward adversarial verification of findings. " +
  "Work without a workflow only for conversational turns and trivial or already-verified edits.";

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

/** The output tokens the first budget directive in `text` asks for, if any. */
export function parseBudgetDirective(text: string): number | undefined {
  const match = BUDGET_DIRECTIVE_PATTERN.exec(text);
  if (!match) return undefined;
  const multiplier = BUDGET_DIRECTIVE_MULTIPLIERS[(match[2] ?? "").toLowerCase()] ?? 1;
  // Round, not floor: 2.3 * 1000 is 2299.999... in floating point.
  const tokens = Math.round(Number(match[1]) * multiplier);
  return Number.isSafeInteger(tokens) && tokens >= BUDGET_DIRECTIVE_MIN_TOKENS ? tokens : undefined;
}

export function createDynamaxTurnBudget(total: number): DynamaxTurnBudget {
  let spent = 0;
  return {
    total,
    remaining: () => Math.max(0, total - spent),
    spend(outputTokens) {
      if (Number.isFinite(outputTokens) && outputTokens > 0) spent += outputTokens;
    },
  };
}

export type DynamaxTurnBudgetResolution =
  | { readonly kind: "budget"; readonly budget: number | undefined }
  | { readonly kind: "spent"; readonly total: number };

/**
 * A run's budget: the explicit one when given, else the turn pool's remainder clamped to the run
 * budget range, else none. A pool with less than `min` left is spent.
 */
export function resolveTurnBudget(
  explicit: number | undefined,
  pool: DynamaxTurnBudget | undefined,
  range: { readonly min: number; readonly max: number },
): DynamaxTurnBudgetResolution {
  if (explicit !== undefined || pool === undefined) return { kind: "budget", budget: explicit };
  const remaining = pool.remaining();
  if (remaining < range.min) return { kind: "spent", total: pool.total };
  return { kind: "budget", budget: Math.min(range.max, Math.floor(remaining)) };
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
 *
 * Sticky mode covers every run, including one a custom message started (`sendMessage` with
 * `triggerTurn`, such as a background completion). Only a user prompt consumes the one-shot: the
 * opt-in belongs to the request the user typed it in.
 */
export function applyDynamaxPromptSection(
  sections: Record<string, string>,
  state: DynamaxState,
  messageType: BeforeAgentStartEvent["messageType"] = "user",
): boolean {
  const oneShot = messageType === "user" && state.oneShotPending;
  if (!state.sticky && !oneShot) return false;
  if (oneShot) state.oneShotPending = false;
  state.turnActive = true;
  sections[DYNAMAX_SECTION] = state.sticky ? DYNAMAX_STICKY_REMINDER : DYNAMAX_REMINDER;
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
    if (event.source === "extension") return { action: "continue" };
    if (hasDynamaxToken(event.text)) markOneShot(ctx);
    const budget = parseBudgetDirective(event.text);
    if (budget !== undefined) getDynamaxRuntime(runtimes, ctx).turnBudget = createDynamaxTurnBudget(budget);
    return { action: "continue" };
  });

  pi.on("before_agent_start", (event, ctx) => {
    const options = event.systemPromptOptions;
    // Subagent sessions load this extension but withhold the workflow tool, so a `dynamax` in a
    // subagent prompt must neither permit that tool nor consume the one-shot.
    if (!options.selectedTools.includes(WORKFLOW_TOOL_NAME)) return undefined;
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (!applyDynamaxPromptSection(options.sections, runtime.state, event.messageType)) return undefined;
    updateDynamaxSurfaces(ctx, runtime);
    return appendSectionToForcedPrompt(options, DYNAMAX_SECTION);
  });

  // Not agent_end: pi emits that per agent loop, and one run continues in fresh loops after a
  // provider retry, overflow compaction, or queued follow-up. agent_settled fires once per run.
  pi.on("agent_settled", (_event, ctx) => {
    const runtime = getDynamaxRuntime(runtimes, ctx);
    if (!runtime.state.sticky) runtime.state.turnActive = false;
    runtime.turnBudget = undefined;
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
    description: "Toggle sticky Dynamax orchestration for this session: /workflow:dynamax [on|off|status]",
    getArgumentCompletions: (argumentPrefix) => completeCurrentArgument(argumentPrefix, DYNAMAX_ACTION_COMPLETIONS),
    handler: async (args, ctx) => {
      const runtime = getDynamaxRuntime(runtimes, ctx);
      const typed = args.trim().toLowerCase();
      const action = typed === "" ? (runtime.state.sticky ? "off" : "on") : typed;
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
      ctx.ui.notify("Usage: /workflow:dynamax [on|off|status] (no argument toggles sticky mode)", "warning");
    },
  });

  return {
    markOneShot,
    turnBudget: (ctx) => getDynamaxRuntime(runtimes, ctx).turnBudget,
    isActive: (ctx) => isDynamaxActive(getDynamaxRuntime(runtimes, ctx).state),
  };
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
