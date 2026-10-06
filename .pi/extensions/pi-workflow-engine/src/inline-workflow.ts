import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { LoadedWorkflow, WorkflowApi } from "./types.ts";
import { unknownErrorMessage } from "./unknown-error.ts";
import { parseWorkflowMeta } from "./workflow-module.ts";

/**
 * v1 inline workflow source contract:
 * - The script starts with `export const meta = { ... };` where the object is a pure literal.
 * - The script contains exactly one `export default async ...` workflow function with a block body,
 *   followed by nothing but an optional `;` and comments.
 * - Inline scripts must not use `import` or any exports other than `meta` and the default function.
 * - `Type` is injected lexically by the host; scripts must use that `Type`, not import typebox.
 */

export class InlineWorkflowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InlineWorkflowCompileError";
  }
}

type InlineWorkflowExecutor = (api: WorkflowApi, typebox: typeof Type) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => InlineWorkflowExecutor;

const AsyncFunction = Object.getPrototypeOf(async function inlineWorkflowCompilerSentinel() {}).constructor as AsyncFunctionConstructor;

export function compileInlineWorkflow(source: string): LoadedWorkflow {
  const code = maskNonCode(source);
  rejectImportSyntax(code);
  const metaLiteral = extractMetaLiteral(source);
  const parsedMeta = parseWorkflowMeta(metaLiteral.value);
  if ("reason" in parsedMeta) throw new InlineWorkflowCompileError(parsedMeta.reason);

  const executor = compileExecutor(extractDefaultWorkflowExpression(source, code, metaLiteral.endOffset));
  return {
    meta: parsedMeta.meta,
    default: (api) => executor(api, Type),
    source: { kind: "fingerprint", fingerprint: createHash("sha256").update(source).digest("hex") },
  };
}

function extractMetaLiteral(source: string): { readonly value: unknown; readonly endOffset: number } {
  const start = skipWhitespace(source, 0);
  const prefix = /export\s+const\s+meta\s*=/y;
  prefix.lastIndex = start;
  const match = prefix.exec(source);
  if (!match || match.index !== start) {
    throw new InlineWorkflowCompileError("inline workflow must start with `export const meta = { ... }`;");
  }

  const objectStart = skipWhitespace(source, prefix.lastIndex);
  if (source[objectStart] !== "{") {
    throw new InlineWorkflowCompileError("inline workflow meta must be an object literal");
  }

  const parser = new LiteralParser(source, objectStart);
  const value = parser.parseValue();
  let endOffset = skipWhitespace(source, parser.offset);
  if (source[endOffset] === ";") endOffset++;

  return { value, endOffset };
}

/**
 * Enforce the no-`import` rule on code only, so prompts may mention imports. This is a lint
 * against honest mistakes, not a security boundary: inline code can still reach eval.
 */
function rejectImportSyntax(code: string): void {
  // `import` as a keyword: not part of a longer identifier, a `.import` member, or an `import:` key.
  const match = /(?<![\w$]|[^.]\.)import(?![\w$])(?!\s*:)(\s*\()?/.exec(code);
  if (!match) return;
  throw new InlineWorkflowCompileError(
    match[1] === undefined
      ? "inline workflows must not contain import statements; use injected Type instead"
      : "inline workflows must not use dynamic import()",
  );
}

function extractDefaultWorkflowExpression(source: string, code: string, startOffset: number): string {
  const start = skipWhitespace(code, startOffset);
  if (start === code.length) throw new InlineWorkflowCompileError("inline workflow must export a default async function");
  const prefix = /export\s+default\b\s*/y;
  prefix.lastIndex = start;
  if (!prefix.test(code)) {
    throw new InlineWorkflowCompileError("inline workflow default export must directly follow the meta declaration");
  }

  const expressionStart = prefix.lastIndex;
  const expressionEnd = defaultFunctionEnd(code, expressionStart);
  if (!/^\s*;?\s*$/.test(code.slice(expressionEnd))) {
    throw new InlineWorkflowCompileError("inline workflow must not contain code after the default export");
  }
  return source.slice(expressionStart, expressionEnd);
}

/**
 * End of the default export in the code-only view: the brace closing the function's block body.
 * The parser cannot find it, because `fn, 5` and `fn\n(api)` (an immediate call) both parse as
 * one expression; cutting here rejects them before any workflow code runs. Like the import rule,
 * this is a lint over the masked view, not a security boundary.
 */
function defaultFunctionEnd(code: string, start: number): number {
  const head = /async\s+(?<keyword>function\b)\s*(?:[A-Za-z_$][\w$]*\s*)?(?=\()|async\s*(?=\()|async\s+[A-Za-z_$][\w$]*\s*(?==>)/y;
  head.lastIndex = start;
  const match = head.exec(code);
  if (!match) {
    throw new InlineWorkflowCompileError("inline workflow default export must be an async function or async arrow function");
  }

  let cursor = head.lastIndex;
  if (code[cursor] === "(") cursor = skipWhitespace(code, closingBracket(code, cursor) + 1);
  if (match.groups?.keyword === undefined) {
    if (!code.startsWith("=>", cursor)) throw new InlineWorkflowCompileError("default async arrow workflow must use =>");
    cursor = skipWhitespace(code, cursor + 2);
  }
  if (code[cursor] !== "{") throw new InlineWorkflowCompileError("default async workflow must use a block body");
  return closingBracket(code, cursor) + 1;
}

/** Index of the bracket closing the one at `open`, counting every bracket kind in the code-only view. */
function closingBracket(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    const char = code[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if ((char === ")" || char === "]" || char === "}") && --depth === 0) return index;
  }
  throw new InlineWorkflowCompileError("inline workflow default export has an unclosed bracket");
}

function compileExecutor(defaultExpression: string): InlineWorkflowExecutor {
  try {
    // The expression already ends at the function body's closing brace; the parentheses also make
    // the parser reject anything that is not a single expression.
    return new AsyncFunction("api", "Type", `"use strict";\nconst workflow = (\n${defaultExpression}\n);\nreturn await workflow(api);`);
  } catch (error) {
    throw new InlineWorkflowCompileError(`inline workflow default export did not compile: ${unknownErrorMessage(error)}`);
  }
}

class LiteralParser {
  private index: number;

  constructor(private readonly source: string, offset: number) {
    this.index = offset;
  }

  get offset(): number {
    return this.index;
  }

  parseValue(): unknown {
    this.skipWhitespace();
    const char = this.source[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"' || char === "'") return this.parseString(char);
    if (char === "-" || isDigit(char)) return this.parseNumber();
    if (this.source.startsWith("true", this.index)) return this.consumeKeyword("true", true);
    if (this.source.startsWith("false", this.index)) return this.consumeKeyword("false", false);
    if (this.source.startsWith("null", this.index)) return this.consumeKeyword("null", null);
    if (char === "`") this.fail("template literals are not allowed in inline workflow meta");
    this.fail(`unexpected token in inline workflow meta: ${char ?? "end of input"}`);
  }

  private parseObject(): Record<string, unknown> {
    const object: Record<string, unknown> = {};
    this.expect("{");
    this.skipWhitespace();
    if (this.peek() === "}") {
      this.index++;
      return object;
    }

    while (true) {
      this.skipWhitespace();
      if (this.source.startsWith("...", this.index)) this.fail("spread properties are not allowed in inline workflow meta");
      if (this.peek() === "[") this.fail("computed properties are not allowed in inline workflow meta");
      const key = this.parsePropertyKey();
      this.skipWhitespace();
      if (this.peek() !== ":") this.fail("inline workflow meta properties must use explicit key: value syntax");
      this.index++;
      object[key] = this.parseValue();
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index++;
        this.skipWhitespace();
        if (this.peek() === "}") {
          this.index++;
          return object;
        }
        continue;
      }
      if (next === "}") {
        this.index++;
        return object;
      }
      this.fail("expected `,` or `}` in inline workflow meta object");
    }
  }

  private parseArray(): unknown[] {
    const array: unknown[] = [];
    this.expect("[");
    this.skipWhitespace();
    if (this.peek() === "]") {
      this.index++;
      return array;
    }

    while (true) {
      array.push(this.parseValue());
      this.skipWhitespace();
      const next = this.peek();
      if (next === ",") {
        this.index++;
        this.skipWhitespace();
        if (this.peek() === "]") {
          this.index++;
          return array;
        }
        continue;
      }
      if (next === "]") {
        this.index++;
        return array;
      }
      this.fail("expected `,` or `]` in inline workflow meta array");
    }
  }

  private parsePropertyKey(): string {
    const char = this.peek();
    if (char === '"' || char === "'") return this.parseString(char);
    if (!isIdentifierStart(char)) this.fail("inline workflow meta property keys must be strings or identifiers");
    const start = this.index;
    this.index++;
    while (isIdentifierPart(this.peek())) this.index++;
    return this.source.slice(start, this.index);
  }

  private parseString(quote: string): string {
    this.expect(quote);
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === quote) {
        this.index++;
        return value;
      }
      if (char === "\\") {
        value += this.parseEscapeSequence();
        continue;
      }
      if (char === "\n" || char === "\r") this.fail("inline workflow meta strings must not contain raw newlines");
      value += char;
      this.index++;
    }
    this.fail("unterminated string in inline workflow meta");
  }

  private parseEscapeSequence(): string {
    this.expect("\\");
    const escaped = this.source[this.index];
    if (escaped === undefined) this.fail("unterminated escape sequence in inline workflow meta");
    this.index++;
    switch (escaped) {
      case '"':
      case "'":
      case "\\":
      case "/":
        return escaped;
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case "u": {
        const hex = this.source.slice(this.index, this.index + 4);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) this.fail("invalid unicode escape in inline workflow meta");
        this.index += 4;
        return String.fromCharCode(Number.parseInt(hex, 16));
      }
      default:
        this.fail(`unsupported escape sequence \\${escaped} in inline workflow meta`);
    }
  }

  private parseNumber(): number {
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    match.lastIndex = this.index;
    const parsed = match.exec(this.source);
    if (!parsed) this.fail("invalid number in inline workflow meta");
    this.index = match.lastIndex;
    return Number(parsed[0]);
  }

  private consumeKeyword<T>(keyword: string, value: T): T {
    this.index += keyword.length;
    if (isIdentifierPart(this.peek())) this.fail(`unexpected identifier after ${keyword} in inline workflow meta`);
    return value;
  }

  private skipWhitespace(): void {
    this.index = skipWhitespace(this.source, this.index);
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private expect(char: string): void {
    if (this.source[this.index] !== char) this.fail(`expected ${char} in inline workflow meta`);
    this.index++;
  }

  private fail(message: string): never {
    throw new InlineWorkflowCompileError(`${message} at offset ${this.index}`);
  }
}

const REGEX_PREFIX_KEYWORDS = new Set([
  "await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return", "throw", "typeof", "void", "yield",
]);
const CONTROL_HEAD_KEYWORDS = new Set(["for", "if", "while"]);

/**
 * Blank the contents of strings, template text, comments and regex literals, keeping offsets
 * and delimiters, so keyword and bracket checks see only code. A `/` after `]`, `}` or any `)`
 * but an `if`/`for`/`while` head's is read as division, so a regex literal opening a statement
 * after a block's `}` stays unmasked. The parser still decides whether a script is valid.
 */
function maskNonCode(source: string): string {
  const masked = source.split("");
  const blank = (start: number, end: number): number => {
    masked.fill(" ", start, end);
    return end;
  };
  // One entry per open brace; true when it is a template `${` whose `}` resumes template text.
  const braces: boolean[] = [];
  const templateText = (start: number): number => {
    for (let index = start; index < source.length; index++) {
      if (source[index] === "\\") index++;
      else if (source[index] === "`") return blank(start, index) + 1;
      else if (source.startsWith("${", index)) {
        braces.push(true);
        return blank(start, index) + 2;
      }
    }
    return blank(start, source.length);
  };
  // One entry per open paren; true when it opens an `if`/`for`/`while` head, after which `/` starts a regex.
  const parens: boolean[] = [];
  const controlHeadEnds = new Set<number>();

  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (source.startsWith("//", index)) {
      const newline = source.indexOf("\n", index);
      index = blank(index, newline === -1 ? source.length : newline);
    } else if (source.startsWith("/*", index)) {
      const close = source.indexOf("*/", index + 2);
      index = blank(index, close === -1 ? source.length : close + 2);
    } else if (char === '"' || char === "'") {
      index = blank(index + 1, quotedTextEnd(source, index + 1, char)) + 1;
    } else if (char === "`") {
      index = templateText(index + 1);
    } else if (char === "{") {
      braces.push(false);
      index++;
    } else if (char === "}") {
      index = braces.pop() === true ? templateText(index + 1) : index + 1;
    } else if (char === "(") {
      parens.push(CONTROL_HEAD_KEYWORDS.has(wordBefore(masked, index)));
      index++;
    } else if (char === ")") {
      if (parens.pop() === true) controlHeadEnds.add(index);
      index++;
    } else if (char === "/" && regexCanStart(masked, index, controlHeadEnds)) {
      const close = regexLiteralEnd(source, index + 1);
      index = close === undefined ? index + 1 : blank(index + 1, close) + 1;
    } else {
      index++;
    }
  }
  return masked.join("");
}

/** Index of the closing quote, or of the line break that leaves a broken string confined to one line. */
function quotedTextEnd(source: string, start: number, quote: string): number {
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (char === quote || char === "\n") return index;
  }
  return source.length;
}

/** Whether a `/` here starts a regex literal, judged by the code token before it. */
function regexCanStart(masked: readonly string[], slash: number, controlHeadEnds: ReadonlySet<number>): boolean {
  let end = slash - 1;
  while (end >= 0 && /\s/.test(masked[end])) end--;
  if (end < 0) return true;
  if (masked[end] === ")") return controlHeadEnds.has(end);
  if (/[\w$]/.test(masked[end])) return REGEX_PREFIX_KEYWORDS.has(wordBefore(masked, slash));
  return !/[\]}"'`]/.test(masked[end]);
}

/** The identifier or keyword ending just before `index`, skipping whitespace; empty when there is none. */
function wordBefore(masked: readonly string[], index: number): string {
  let end = index;
  while (end > 0 && /\s/.test(masked[end - 1])) end--;
  let start = end;
  while (start > 0 && /[\w$]/.test(masked[start - 1])) start--;
  return masked.slice(start, end).join("");
}

/** Index of the closing `/` of a regex literal body starting at `start`, if it closes on this line. */
function regexLiteralEnd(source: string, start: number): number | undefined {
  let inClass = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (char === "\\") index++;
    else if (char === "\n") return undefined;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index;
  }
  return undefined;
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? "")) index++;
  return index;
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= "0" && value <= "9";
}

function isIdentifierStart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z_$]/.test(value);
}

function isIdentifierPart(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_$]/.test(value);
}
