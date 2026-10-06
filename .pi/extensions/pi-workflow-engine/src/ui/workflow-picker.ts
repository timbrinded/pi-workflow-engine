import type { Theme } from "@earendil-works/pi-coding-agent";
import { SelectList, visibleWidth, type Component, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import { dot, fit, keyHints } from "./kit.ts";

const MAX_VISIBLE = 10;
const NAME_GAP = 2;

/**
 * The `/workflow` picker: pi's own `SelectList` (so names and descriptions align like the slash
 * autocomplete) under a title, with key hints below, between two rules like pi's native selectors.
 * Items without a description (the author option) render as a full-width label.
 */
export class WorkflowPicker implements Component {
  private readonly list: SelectList;

  constructor(
    private readonly items: readonly SelectItem[],
    private readonly theme: Theme,
    listTheme: SelectListTheme,
    done: (value: string | undefined) => void,
  ) {
    const nameWidth = Math.max(0, ...items.filter((item) => item.description).map((item) => visibleWidth(item.label))) + NAME_GAP;
    this.list = new SelectList([...items], Math.min(MAX_VISIBLE, items.length), listTheme, {
      minPrimaryColumnWidth: nameWidth,
      maxPrimaryColumnWidth: nameWidth,
    });
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const rule = this.theme.fg("border", "─".repeat(Math.max(1, width)));
    const count = this.items.filter((item) => item.description).length;
    const title = `${this.theme.fg("accent", this.theme.bold("Run a workflow"))}${dot(this.theme)}${this.theme.fg("muted", `${count} available`)}`;
    const hints = keyHints([["↑↓", "move"], ["enter", "run"], ["esc", "cancel"]], this.theme);
    const pad = (line: string) => ` ${fit(line, inner)} `;
    return [rule, pad(title), "", ...this.list.render(inner).map(pad), "", pad(hints), rule];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}
