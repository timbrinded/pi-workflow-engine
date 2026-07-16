import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";

export const DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT = "ctrl+shift+m" satisfies KeyId;
export const DEFAULT_REVIEW_RESULTS_SHORTCUT = "ctrl+shift+r" satisfies KeyId;

const CONFIG_FILE_NAME = "pi-workflow-engine.json";

export interface DynamaxShortcuts {
  inspector: KeyId | null;
  results: KeyId | null;
}

interface DynamaxShortcutConfig {
  inspector?: unknown;
  results?: unknown;
}

export function dynamaxShortcutsConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", CONFIG_FILE_NAME);
}

export function resolveDynamaxShortcuts(configPath: string = dynamaxShortcutsConfigPath()): DynamaxShortcuts {
  if (!existsSync(configPath)) return defaultDynamaxShortcuts();

  const config = readShortcutConfig(configPath);
  if (!config) return defaultDynamaxShortcuts();

  const shortcuts = {
    inspector: shortcutFromConfig("inspector", config.inspector, DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT, configPath),
    results: shortcutFromConfig("results", config.results, DEFAULT_REVIEW_RESULTS_SHORTCUT, configPath),
  };
  if (shortcuts.inspector && shortcuts.results && shortcutIdentity(shortcuts.inspector) === shortcutIdentity(shortcuts.results)) {
    console.warn(`Duplicate pi-workflow-engine shortcut ${shortcuts.inspector} in ${configPath}; disabling the results shortcut.`);
    return { inspector: shortcuts.inspector, results: null };
  }
  return shortcuts;
}

function readShortcutConfig(configPath: string): DynamaxShortcutConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    warnUsingDefaults("Could not read", configPath);
    return null;
  }

  const shortcuts = isRecord(parsed) ? parsed.shortcuts : undefined;
  if (shortcuts === undefined) return {};
  if (!isRecord(shortcuts)) {
    warnUsingDefaults("Invalid", configPath);
    return null;
  }

  return shortcuts;
}

function shortcutFromConfig(
  name: keyof DynamaxShortcutConfig,
  configured: unknown,
  fallback: KeyId,
  configPath: string,
): KeyId | null {
  if (configured === null) return null;
  if (configured === undefined) return fallback;
  if (typeof configured === "string") {
    const normalized = configured.trim();
    if (isKeyId(normalized)) return normalized;
  }
  console.warn(`Invalid ${name} shortcut in ${configPath}; using ${fallback}.`);
  return fallback;
}

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const NAMED_BASE_KEYS = new Set<string>(Object.values(Key).flatMap((value) => (typeof value === "string" ? [String(value)] : [])));

function isKeyId(value: string): value is KeyId {
  return parseKeyId(value) !== undefined;
}

function parseKeyId(value: string): { readonly modifiers: readonly string[]; readonly base: string } | undefined {
  const seen = new Set<string>();
  let base = value;
  while (true) {
    const separator = base.indexOf("+");
    if (separator < 0) break;
    const modifier = base.slice(0, separator);
    if (!MODIFIERS.has(modifier) || seen.has(modifier)) break;
    seen.add(modifier);
    base = base.slice(separator + 1);
  }
  return isBaseKey(base) ? { modifiers: [...seen], base } : undefined;
}

function isBaseKey(value: string): boolean {
  return /^[a-z0-9]$/.test(value) || NAMED_BASE_KEYS.has(value);
}

function shortcutIdentity(shortcut: KeyId): string {
  const parsed = parseKeyId(shortcut);
  if (!parsed) return shortcut;
  const base = parsed.base === "esc" ? "escape" : parsed.base === "return" ? "enter" : parsed.base;
  return `${[...parsed.modifiers].sort().join("+")}+${base}`;
}

function defaultDynamaxShortcuts(): DynamaxShortcuts {
  return { inspector: DEFAULT_DYNAMAX_INSPECTOR_SHORTCUT, results: DEFAULT_REVIEW_RESULTS_SHORTCUT };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnUsingDefaults(reason: "Could not read" | "Invalid", configPath: string): void {
  console.warn(`${reason} pi-workflow-engine config at ${configPath}; using default workflow shortcuts.`);
}
