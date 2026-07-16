import { Type } from "typebox";
import { createHash } from "node:crypto";
import type { LoadedWorkflow, WorkflowApi, WorkflowMeta } from "./types.ts";
import { parseWorkflowMeta } from "./workflow-module.ts";

/**
 * v1 inline workflow source contract:
 * - The script starts with `export const meta = { ... };` where the object is a pure literal.
 * - The script contains exactly one `export default async ...` workflow function.
 * - Inline scripts must not use `import` or any exports other than `meta` and the default function.
 * - `Type` is injected lexically by the host; scripts must use that `Type`, not import typebox.
 */

export class InlineWorkflowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InlineWorkflowCompileError";
  }
}

export interface InlineMetaLiteral {
  readonly literal: string;
  readonly value: unknown;
  readonly endOffset: number;
}

type InlineWorkflowExecutor = (api: WorkflowApi, typebox: typeof Type) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => InlineWorkflowExecutor;

const AsyncFunction = Object.getPrototypeOf(async function inlineWorkflowCompilerSentinel() {}).constructor as AsyncFunctionConstructor;

export function compileInlineWorkflow(source: string): LoadedWorkflow {
  rejectForbiddenModuleSyntax(source);
  const metaLiteral = extractMetaLiteral(source);
  const parsedMeta = parseWorkflowMeta(metaLiteral.value);
  if ("reason" in parsedMeta) throw new InlineWorkflowCompileError(parsedMeta.reason);

  const defaultExpression = extractDefaultWorkflowExpression(source, metaLiteral.endOffset);
  const executor = compileExecutor(defaultExpression);
  return {
    meta: parsedMeta.meta,
    default: (api) => executor(api, Type),
    source: { kind: "fingerprint", fingerprint: createHash("sha256").update(source).digest("hex") },
  };
}

export function extractMetaLiteral(source: string): InlineMetaLiteral {
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
  const literalEnd = parser.offset;
  let endOffset = skipWhitespace(source, literalEnd);
  if (source[endOffset] === ";") endOffset++;

  return { literal: source.slice(objectStart, literalEnd), value, endOffset };
}

function rejectForbiddenModuleSyntax(source: string): void {
  if (/^\s*import\s/m.test(source)) {
    throw new InlineWorkflowCompileError("inline workflows must not contain import statements; use injected Type instead");
  }
  if (/\bimport\s*\(/.test(source)) {
    throw new InlineWorkflowCompileError("inline workflows must not use dynamic import()");
  }
}

function extractDefaultWorkflowExpression(source: string, startOffset: number): string {
  const moduleSource = source.slice(startOffset).trim();
  if (!moduleSource) throw new InlineWorkflowCompileError("inline workflow must export a default async function");
  if (!moduleSource.startsWith("export default")) {
    throw new InlineWorkflowCompileError("inline workflow default export must directly follow the meta declaration");
  }

  const defaultPrefix = /^export\s+default\s+/;
  const match = defaultPrefix.exec(moduleSource);
  if (!match) throw new InlineWorkflowCompileError("inline workflow must export a default async function");

  const expressionSource = moduleSource.slice(match[0].length).trimStart();
  const bodyOpen = findDefaultBodyOpen(expressionSource);
  const bodyClose = findMatchingDelimiter(expressionSource, bodyOpen, "{", "}");
  const expression = expressionSource.slice(0, bodyClose + 1);
  const remainder = expressionSource.slice(bodyClose + 1).trim();
  if (remainder !== "" && remainder !== ";") {
    throw new InlineWorkflowCompileError("inline workflow must not contain code after the default export");
  }
  return expression;
}

function findDefaultBodyOpen(expressionSource: string): number {
  const functionMatch = /^async\s+function(?:\s+[A-Za-z_$][\w$]*)?\s*/.exec(expressionSource);
  if (functionMatch) {
    const paramsOpen = skipWhitespace(expressionSource, functionMatch[0].length);
    if (expressionSource[paramsOpen] !== "(") {
      throw new InlineWorkflowCompileError("default async function must declare parameters with parentheses");
    }
    const paramsClose = findMatchingDelimiter(expressionSource, paramsOpen, "(", ")");
    const bodyOpen = skipWhitespace(expressionSource, paramsClose + 1);
    if (expressionSource[bodyOpen] !== "{") {
      throw new InlineWorkflowCompileError("default async function must use a block body");
    }
    return bodyOpen;
  }

  const arrowMatch = /^async\s*/.exec(expressionSource);
  if (arrowMatch) {
    const paramsOpen = skipWhitespace(expressionSource, arrowMatch[0].length);
    if (expressionSource[paramsOpen] !== "(") {
      throw new InlineWorkflowCompileError("default async arrow workflow must declare parameters with parentheses");
    }
    const paramsClose = findMatchingDelimiter(expressionSource, paramsOpen, "(", ")");
    let cursor = skipWhitespace(expressionSource, paramsClose + 1);
    if (!expressionSource.startsWith("=>", cursor)) {
      throw new InlineWorkflowCompileError("default async arrow workflow must use =>");
    }
    cursor = skipWhitespace(expressionSource, cursor + 2);
    if (expressionSource[cursor] !== "{") {
      throw new InlineWorkflowCompileError("default async arrow workflow must use a block body");
    }
    return cursor;
  }

  throw new InlineWorkflowCompileError("inline workflow default export must be an async function or async arrow function");
}

function compileExecutor(defaultExpression: string): InlineWorkflowExecutor {
  try {
    return new AsyncFunction("api", "Type", `"use strict";\nconst workflow = ${defaultExpression};\nreturn await workflow(api);`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new InlineWorkflowCompileError(`inline workflow default export did not compile: ${message}`);
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

function findMatchingDelimiter(source: string, openIndex: number, open: string, close: string): number {
  let depth = 1;
  let index = openIndex + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipQuotedSource(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
      continue;
    }
    if (char === open) depth++;
    if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  throw new InlineWorkflowCompileError(`unterminated ${open}${close} block in inline workflow default export`);
}

function skipQuotedSource(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    index++;
  }
  throw new InlineWorkflowCompileError("unterminated string in inline workflow default export");
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline + 1;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end === -1) throw new InlineWorkflowCompileError("unterminated block comment in inline workflow default export");
  return end + 2;
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
