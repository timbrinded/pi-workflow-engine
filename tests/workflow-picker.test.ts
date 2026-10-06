import assert from "node:assert/strict";
import { test } from "bun:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import { pickWorkflow } from "../.pi/extensions/pi-workflow-engine/index.ts";
import type { WorkflowModule } from "../.pi/extensions/pi-workflow-engine/src/types.ts";
import { WorkflowPicker } from "../.pi/extensions/pi-workflow-engine/src/ui/workflow-picker.ts";
import { captureWorkflowExtension } from "./workflow-extension-fixtures.ts";
import { createTestTheme, plain } from "./fixtures/theme.ts";

const ENTER = "\r";
const ESCAPE = "\u001b";
const DOWN = "\u001b[B";

const LIST_THEME: SelectListTheme = {
  selectedPrefix: (text) => text,
  selectedText: (text) => text,
  description: (text) => text,
  scrollInfo: (text) => text,
  noMatch: (text) => text,
};

const ITEMS: SelectItem[] = [
  { value: "code-review", label: "code-review", description: "Fan-out review of the branch's open PR: scope, find, verify, synthesize." },
  { value: "refactor-scout", label: "refactor-scout", description: "Advisory-only refactor scout with a deliberately long description that must not wrap." },
  { value: "author", label: "+ author a one-off workflow" },
];

test("the picker aligns descriptions in one column and fits every line to the width", () => {
  for (const width of [140, 90, 60]) {
    const lines = new WorkflowPicker(ITEMS, createTestTheme(), LIST_THEME, () => {}).render(width).map(plain);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width}`);
    assert.match(lines.join("\n"), /Run a workflow · 2 available/);
    assert.match(lines.join("\n"), /↑↓ move · enter run · esc cancel/);

    const review = lines.find((line) => line.includes("code-review ")) ?? "";
    const scout = lines.find((line) => line.includes("refactor-scout ")) ?? "";
    assert.equal(review.indexOf("Fan-out"), scout.indexOf("Advisory-only"), `descriptions align at width ${width}`);
    assert.ok(lines.some((line) => line.includes("+ author a one-off workflow")), "the author option is not truncated by the name column");
  }
});

test("the picker returns the chosen value on enter and undefined on escape", () => {
  const chosen: (string | undefined)[] = [];
  const picker = new WorkflowPicker(ITEMS, createTestTheme(), LIST_THEME, (value) => chosen.push(value));
  picker.handleInput(DOWN);
  picker.handleInput(ENTER);
  picker.handleInput(ESCAPE);
  assert.deepEqual(chosen, ["refactor-scout", undefined]);
});

test("pickWorkflow offers built-ins in discovery order with the author option last", async () => {
  const workflows = new Map<string, WorkflowModule>([
    ["code-review", { meta: { name: "code-review", description: "Review code" }, default: async () => "ok" }],
    ["diagnose", { meta: { name: "diagnose", description: "Diagnose bugs" }, default: async () => "ok" }],
  ]);
  const pickRow = async (downs: number) => {
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        async custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component): Promise<T> {
          let result: T | undefined;
          const picker = factory(undefined, createTestTheme(), undefined, (value) => {
            result = value;
          });
          if (!(picker instanceof WorkflowPicker)) throw new Error("expected the workflow picker");
          for (let index = 0; index < downs; index++) picker.handleInput(DOWN);
          picker.handleInput(ENTER);
          return result as T;
        },
        async input() {
          return "";
        },
        async editor() {
          return "summarize risks";
        },
      },
    } as unknown as ExtensionCommandContext;
    return await pickWorkflow(workflows, ctx);
  };

  assert.deepEqual(await pickRow(0), { kind: "run", name: "code-review", args: "" });
  assert.deepEqual(await pickRow(1), { kind: "run", name: "diagnose", args: "" });
  assert.deepEqual(await pickRow(2), { kind: "author", brief: "summarize risks" });
  assert.deepEqual(await pickRow(3), { kind: "run", name: "code-review", args: "" }, "the author option is the last row");
});

test("dismissing the /workflow picker cancels silently; usage is printed only without a UI", async () => {
  const command = captureWorkflowExtension().commands.get("workflow");
  if (!command) throw new Error("expected /workflow command");

  const notifications: string[] = [];
  let pickerOpened = 0;
  const tui = {
    cwd: process.cwd(),
    hasUI: true,
    mode: "tui",
    ui: {
      async custom<T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => Component): Promise<T> {
        pickerOpened++;
        let result: T | undefined;
        factory(undefined, createTestTheme(), undefined, (value) => {
          result = value;
        }).handleInput?.(ESCAPE);
        return result as T;
      },
      notify: (message: string) => notifications.push(message),
    },
  } as unknown as ExtensionCommandContext;
  await command.handler("", tui);
  assert.equal(pickerOpened, 1);
  assert.deepEqual(notifications, []);

  const headless = { ...tui, hasUI: false, mode: "print" } as unknown as ExtensionCommandContext;
  await command.handler("", headless);
  assert.equal(pickerOpened, 1, "no picker without a UI");
  assert.match(notifications.at(-1) ?? "", /^Usage: \/workflow <name> \[args\]\. Available: code-review/);
});
