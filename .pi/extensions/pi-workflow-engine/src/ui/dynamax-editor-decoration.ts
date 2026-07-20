import type { EditorComponent } from "@earendil-works/pi-tui";

export type DynamaxEffect = "shine" | "static" | "off";

export interface DynamaxAnimationScheduler {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface DynamaxEditorDecoration {
  readonly editor: EditorComponent;
  dispose(): void;
}

export interface DynamaxEditorDecorationOptions {
  getEffect?: () => DynamaxEffect;
  scheduler?: DynamaxAnimationScheduler;
  isActive?: () => boolean;
}

const DYNAMAX_RENDER_PATTERN = /(^|[^A-Za-z0-9_])(dynamax)(?=[^A-Za-z0-9_]|$)/gi;
const DYNAMAX_COLORS = [
  [233, 137, 115],
  [228, 186, 103],
  [141, 192, 122],
  [102, 194, 179],
  [121, 157, 207],
  [157, 134, 195],
  [206, 130, 172],
] as const;
const RESET_FOREGROUND = "\x1b[39m";
export const DYNAMAX_EFFECT_ENV = "PI_DYNAMAX_EFFECT";
export const DYNAMAX_ANIMATION_FRAME_MS = 135;
const DYNAMAX_SHINE_FRAME_COUNT = DYNAMAX_COLORS.length;
const DEFAULT_DYNAMAX_ANIMATION_SCHEDULER: DynamaxAnimationScheduler = {
  now: () => performance.now(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export function resolveDynamaxEffect(env: NodeJS.ProcessEnv = process.env): DynamaxEffect {
  const configured = env[DYNAMAX_EFFECT_ENV]?.trim().toLowerCase();
  if (configured === "shine" || configured === "static" || configured === "off") return configured;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "off";
  return "shine";
}

export function highlightDynamaxTokens(line: string, shinePosition?: number): string {
  const { visibleText, rawPositions } = mapVisibleCharacters(line);
  const insertions = new Map<number, string>();
  for (const match of visibleText.matchAll(DYNAMAX_RENDER_PATTERN)) {
    const token = match[2]!;
    const visibleStart = match.index! + match[1]!.length;
    for (let index = 0; index < token.length; index++) {
      const rawPosition = rawPositions[visibleStart + index]!;
      const color = DYNAMAX_COLORS[index % DYNAMAX_COLORS.length]!;
      const shine = shinePosition === undefined ? (index === 0 ? 0.45 : 0) : shineFactor(index, shinePosition);
      insertions.set(rawPosition, foregroundColor(color, shine));
    }
    const restorePosition = rawPositions[visibleStart + token.length] ?? line.length;
    insertions.set(restorePosition, activeForegroundAt(line, restorePosition));
  }
  if (insertions.size === 0) return line;

  let highlighted = "";
  for (let rawPosition = 0; rawPosition <= line.length; rawPosition++) {
    highlighted += insertions.get(rawPosition) ?? "";
    if (rawPosition < line.length) highlighted += line[rawPosition];
  }
  return highlighted;
}

export function decorateDynamaxEditor(
  editor: EditorComponent,
  requestRender: () => void,
  options: DynamaxEditorDecorationOptions = {},
): DynamaxEditorDecoration {
  const originalRender = editor.render;
  const scheduler = options.scheduler ?? DEFAULT_DYNAMAX_ANIMATION_SCHEDULER;
  const getEffect = options.getEffect ?? resolveDynamaxEffect;
  const isActive = options.isActive ?? (() => true);
  let disposed = false;
  let cancelScheduled: (() => void) | undefined;
  let lastSignature: string | undefined;
  let lastEffect: DynamaxEffect | undefined;
  let animationStartedAt: number | undefined;

  const cancelAnimation = (): void => {
    cancelScheduled?.();
    cancelScheduled = undefined;
    animationStartedAt = undefined;
  };
  const scheduleRender = (delayMs: number): void => {
    if (cancelScheduled || disposed || !isActive()) return;
    cancelScheduled = scheduler.schedule(() => {
      cancelScheduled = undefined;
      if (disposed || !isActive()) return;
      requestRender();
    }, Math.max(0, delayMs));
  };

  const decoratedRender = (width: number): string[] => {
    const lines = originalRender.call(editor, width);
    const effect = getEffect();
    const signature = visibleDynamaxSignature(lines);
    if (signature !== lastSignature || effect !== lastEffect) {
      cancelAnimation();
      lastSignature = signature;
      lastEffect = effect;
      if (signature && effect === "shine" && isActive()) animationStartedAt = scheduler.now();
    }

    let shinePosition: number | undefined;
    if (animationStartedAt !== undefined && signature && effect === "shine" && isActive()) {
      const now = scheduler.now();
      const elapsed = Math.max(0, now - animationStartedAt);
      const frame = Math.floor(elapsed / DYNAMAX_ANIMATION_FRAME_MS);
      if (frame < DYNAMAX_SHINE_FRAME_COUNT) {
        shinePosition = frame;
        const nextFrameAt = animationStartedAt + (frame + 1) * DYNAMAX_ANIMATION_FRAME_MS;
        scheduleRender(nextFrameAt - now);
      } else {
        cancelAnimation();
      }
    } else if (!signature || effect !== "shine" || !isActive()) {
      cancelAnimation();
    }

    if (effect === "off") return lines;
    return lines.map((line) => highlightDynamaxTokens(line, shinePosition));
  };

  editor.render = decoratedRender;
  return {
    editor,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimation();
      if (editor.render === decoratedRender) editor.render = originalRender;
    },
  };
}

function shineFactor(index: number, shinePosition: number): number {
  const distance = Math.abs(index - shinePosition);
  if (distance === 0) return 0.7;
  if (distance === 1) return 0.3;
  return 0;
}

function foregroundColor(color: readonly [number, number, number], shine: number): string {
  const red = Math.round(color[0] + (255 - color[0]) * shine);
  const green = Math.round(color[1] + (255 - color[1]) * shine);
  const blue = Math.round(color[2] + (255 - color[2]) * shine);
  return `\x1b[38;2;${red};${green};${blue}m`;
}

function mapVisibleCharacters(line: string): { visibleText: string; rawPositions: number[] } {
  let visibleText = "";
  const rawPositions: number[] = [];
  let rawPosition = 0;
  while (rawPosition < line.length) {
    const controlLength = terminalControlSequenceLength(line, rawPosition);
    if (controlLength > 0) {
      rawPosition += controlLength;
      continue;
    }
    visibleText += line[rawPosition];
    rawPositions.push(rawPosition);
    rawPosition += 1;
  }
  return { visibleText, rawPositions };
}

function terminalControlSequenceLength(line: string, position: number): number {
  if (line[position] !== "\x1b") return 0;
  const introducer = line[position + 1];
  if (introducer === "[") {
    for (let index = position + 2; index < line.length; index++) {
      const code = line.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) return index - position + 1;
    }
    return line.length - position;
  }
  if (introducer === "]" || introducer === "_") {
    for (let index = position + 2; index < line.length; index++) {
      if (line[index] === "\x07") return index - position + 1;
      if (line[index] === "\x1b" && line[index + 1] === "\\") return index - position + 2;
    }
    return line.length - position;
  }
  return Math.min(2, line.length - position);
}

function activeForegroundAt(line: string, endPosition: number): string {
  let foreground = RESET_FOREGROUND;
  let position = 0;
  while (position < endPosition) {
    const controlLength = terminalControlSequenceLength(line, position);
    if (controlLength === 0) {
      position += 1;
      continue;
    }
    const sequence = line.slice(position, position + controlLength);
    if (sequence.startsWith("\x1b[") && sequence.endsWith("m")) {
      foreground = foregroundAfterSgr(foreground, sequence);
    }
    position += controlLength;
  }
  return foreground;
}

function foregroundAfterSgr(current: string, sequence: string): string {
  const rawParameters = sequence.slice(2, -1);
  const parameters = rawParameters === "" ? ["0"] : rawParameters.split(";");
  let foreground = current;
  for (let index = 0; index < parameters.length; index++) {
    const rawParameter = parameters[index]!;
    const parameter = sgrParameter(rawParameter);
    if (parameter === 0 || parameter === 39) {
      foreground = RESET_FOREGROUND;
      continue;
    }
    if ((parameter >= 30 && parameter <= 37) || (parameter >= 90 && parameter <= 97)) {
      foreground = `\x1b[${parameter}m`;
      continue;
    }
    if (parameter !== 38 && parameter !== 48 && parameter !== 58) continue;

    const extended = parseExtendedSgrColor(parameters, index);
    index = extended.lastIndex;
    if (parameter === 38 && extended.color) foreground = extended.color;
  }
  return foreground;
}

function parseExtendedSgrColor(parameters: string[], index: number): { color?: string; lastIndex: number } {
  const inline = parameters[index]!.split(":");
  if (inline.length > 1) {
    const mode = sgrParameter(inline[1] ?? "");
    if (mode === 5) {
      const paletteIndex = validColorChannel(inline[2]);
      return { color: paletteIndex === undefined ? undefined : `\x1b[38;5;${paletteIndex}m`, lastIndex: index };
    }
    if (mode === 2) {
      const channels = inline.length >= 6 ? inline.slice(-3) : inline.slice(2, 5);
      const rgb = validRgbChannels(channels);
      return { color: rgb ? `\x1b[38;2;${rgb.join(";")}m` : undefined, lastIndex: index };
    }
    return { lastIndex: index };
  }

  const mode = sgrParameter(parameters[index + 1] ?? "");
  if (mode === 5) {
    const paletteIndex = validColorChannel(parameters[index + 2]);
    return {
      color: paletteIndex === undefined ? undefined : `\x1b[38;5;${paletteIndex}m`,
      lastIndex: Math.min(parameters.length - 1, index + 2),
    };
  }
  if (mode === 2) {
    const rgb = validRgbChannels(parameters.slice(index + 2, index + 5));
    return {
      color: rgb ? `\x1b[38;2;${rgb.join(";")}m` : undefined,
      lastIndex: Math.min(parameters.length - 1, index + 4),
    };
  }
  return { lastIndex: Math.min(parameters.length - 1, index + 1) };
}

function validRgbChannels(channels: string[]): [number, number, number] | undefined {
  if (channels.length !== 3) return undefined;
  const parsed = channels.map(validColorChannel);
  if (parsed.some((channel) => channel === undefined)) return undefined;
  return [parsed[0]!, parsed[1]!, parsed[2]!];
}

function validColorChannel(channel: string | undefined): number | undefined {
  if (channel === undefined || !/^\d{1,3}$/.test(channel)) return undefined;
  const parsed = Number(channel);
  return parsed <= 255 ? parsed : undefined;
}

function sgrParameter(parameter: string): number {
  const primary = parameter.split(":", 1)[0];
  if (primary === "") return 0;
  const parsed = Number(primary);
  return Number.isFinite(parsed) ? parsed : -1;
}

function visibleDynamaxSignature(lines: string[]): string {
  const matches: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const { visibleText } = mapVisibleCharacters(lines[lineIndex]!);
    for (const match of visibleText.matchAll(DYNAMAX_RENDER_PATTERN)) {
      const visibleStart = match.index! + match[1]!.length;
      matches.push(`${lineIndex}:${visibleStart}:${match[2]!}`);
    }
  }
  return matches.join("|");
}
