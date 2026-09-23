// Recursive-descent parser for the format language (doc/FORMAT.md).
//
// The source has three sections: the toplevel line (text mode), directives up
// to the first blank line outside a block, and definitions. Errors inside a
// directive or definition are recorded as diagnostics and parsing resumes at
// the next line that starts in column 0.

import type {
  CmpOp, Cond, Definition, Diagnostic, Expr, LiteralValue, MatchArm, MatchPattern,
  Operand, Pos, Program, StyleChange, TextPart,
} from "./ast.js";

class ParseError extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const STYLE_CHAR = /[A-Za-z0-9_-]/;
const TODO_WORDS = new Set(["unchecked", "done", "cancelled", "skipped"]);

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

/** Parse a format. With `base`, positions are marked as coming from an inherited format. */
export function parseProgram(source: string, base = false): ParseResult {
  return new Parser(source.replace(/\r\n?/g, "\n"), base).parse();
}

class Parser {
  private i = 0;
  private readonly lineStarts: number[] = [0];
  readonly diagnostics: Diagnostic[] = [];

  constructor(private readonly src: string, private readonly base = false) {
    for (let j = 0; j < src.length; j++) {
      if (src[j] === "\n") this.lineStarts.push(j + 1);
    }
  }

  // -- Positions and diagnostics ---------------------------------------------

  pos(index: number): Pos {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    const pos: Pos = { line: lo + 1, col: index - this.lineStarts[lo] + 1 };
    if (this.base) pos.base = true;
    return pos;
  }

  private error(message: string, index: number): void {
    this.diagnostics.push({ severity: "error", message, pos: this.pos(index) });
  }

  private warn(message: string, index: number): void {
    this.diagnostics.push({ severity: "warning", message, pos: this.pos(index) });
  }

  private fail(message: string, index = this.i): never {
    throw new ParseError(message, index);
  }

  // -- Low-level scanning ----------------------------------------------------

  private eolIndex(from: number): number {
    const j = this.src.indexOf("\n", from);
    return j < 0 ? this.src.length : j;
  }

  private skipInline(): void {
    while (this.i < this.src.length && (this.src[this.i] === " " || this.src[this.i] === "\t")) this.i++;
  }

  /** Skip spaces, comments, and (if allowed) newlines. */
  private skipWs(newlines: boolean): void {
    for (;;) {
      this.skipInline();
      const c = this.src[this.i];
      if (c === "#") {
        this.i = this.eolIndex(this.i);
      } else if (newlines && c === "\n") {
        this.i++;
      } else {
        return;
      }
    }
  }

  private atEol(): boolean {
    return this.i >= this.src.length || this.src[this.i] === "\n";
  }

  private isWordAt(word: string, index = this.i): boolean {
    if (!this.src.startsWith(word, index)) return false;
    const next = this.src[index + word.length];
    return next === undefined || !IDENT_CHAR.test(next);
  }

  private isWordCI(word: string): boolean {
    const s = this.src.slice(this.i, this.i + word.length);
    if (s.toLowerCase() !== word) return false;
    const next = this.src[this.i + word.length];
    return next === undefined || !IDENT_CHAR.test(next);
  }

  private expectWord(word: string): void {
    this.skipWs(true);
    if (!this.isWordAt(word)) this.fail(`expected '${word}'`);
    this.i += word.length;
  }

  private expectChar(c: string): void {
    this.skipWs(true);
    if (this.src[this.i] !== c) this.fail(`expected '${c}'`);
    this.i++;
  }

  private readIdent(): string {
    const start = this.i;
    if (!IDENT_START.test(this.src[this.i] ?? "")) this.fail("expected a name");
    while (this.i < this.src.length && IDENT_CHAR.test(this.src[this.i])) this.i++;
    return this.src.slice(start, this.i);
  }

  /** Index of the `close` matching the `open` at `start`, honoring nesting and backslash escapes. */
  private matchClose(start: number, end: number, open: string, close: string): number {
    let depth = 0;
    for (let j = start; j < end; j++) {
      const c = this.src[j];
      if (c === "\\") { j++; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j;
    }
    return -1;
  }

  // -- Program structure -----------------------------------------------------

  parse(): ParseResult {
    const firstEol = this.eolIndex(0);
    const toplevel = this.parseText(0, firstEol);
    const program: Program = { toplevel, defs: new Map() };
    this.i = firstEol + 1;

    this.parseDirectives(program);
    this.parseDefinitions(program);
    return { program, diagnostics: this.diagnostics };
  }

  private lineIsBlank(start: number): boolean {
    return this.src.slice(start, this.eolIndex(start)).trim() === "";
  }

  /** Advance to the next line that starts with a non-whitespace character. */
  private recover(): void {
    let j = this.eolIndex(this.i) + 1;
    while (j < this.src.length) {
      const c = this.src[j];
      if (c !== " " && c !== "\t" && c !== "\n") break;
      j = this.eolIndex(j) + 1;
    }
    this.i = Math.min(j, this.src.length);
  }

  private looksLikeDefinition(index: number): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=(?!=)/.test(this.src.slice(index, this.eolIndex(index)));
  }

  private parseDirectives(program: Program): void {
    while (this.i < this.src.length) {
      const lineStart = this.i;
      if (this.lineIsBlank(lineStart)) {
        this.i = this.eolIndex(lineStart) + 1;
        return;
      }
      this.skipInline();
      if (this.src[this.i] === "#") {
        this.i = this.eolIndex(this.i) + 1;
        continue;
      }
      // Accept definitions directly after the toplevel line.
      if (this.looksLikeDefinition(lineStart)) {
        this.i = lineStart;
        return;
      }
      try {
        this.parseDirective(program);
        this.skipWs(false);
        if (!this.atEol()) this.fail("unexpected text after directive");
        this.i = Math.min(this.i + 1, this.src.length);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e.message, e.index);
        this.recover();
      }
    }
  }

  private parseDirective(program: Program): void {
    const start = this.i;
    if (this.isWordAt("wrap")) {
      this.i += 4;
      this.expectWord("as");
      this.skipWs(false);
      const name = this.readIdent();
      this.expectChar(":");
      const body = this.parseBlockBody(false);
      this.expectWord("end");
      if (program.wrap) this.error("only one wrap is allowed", start);
      else program.wrap = { name, body, pos: this.pos(start) };
    } else if (this.isWordAt("tooltip")) {
      this.i += 7;
      this.expectChar(":");
      const body = this.parseBlockBody(false);
      this.expectWord("end");
      if (program.tooltip) this.error("only one tooltip is allowed", start);
      else program.tooltip = body;
    } else if (this.isWordAt("behavior")) {
      this.i += 8;
      this.expectChar(":");
      this.parseBlockBody(false);
      this.expectWord("end");
      this.warn("behavior is not supported yet and is ignored", start);
    } else {
      this.fail("expected a directive (wrap, tooltip) or a blank line before definitions");
    }
  }

  private parseDefinitions(program: Program): void {
    while (this.i < this.src.length) {
      this.skipWs(true);
      if (this.i >= this.src.length) return;
      const start = this.i;
      try {
        const name = this.readIdent();
        this.skipInline();
        if (this.src[this.i] !== "=") this.fail("expected '=' after definition name");
        this.i++;
        const expr = this.parseDefinitionBody();
        if (program.defs.has(name)) this.error(`duplicate definition of '${name}'`, start);
        else program.defs.set(name, { name, expr, pos: this.pos(start) } satisfies Definition);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e.message, e.index);
        this.i = start;
        this.recover();
      }
    }
  }

  private parseDefinitionBody(): Expr {
    this.skipInline();
    if (this.src[this.i] === "#") this.i = this.eolIndex(this.i);
    if (!this.atEol()) return this.parseSeq(() => false, true);

    // `name=` at end of line: the body is the following block of lines
    // indented at least as far as its first line.
    const bodyStart = Math.min(this.i + 1, this.src.length);
    let indent = 0;
    while (this.src[bodyStart + indent] === " " || this.src[bodyStart + indent] === "\t") indent++;
    if (indent === 0 || this.lineIsBlank(bodyStart)) {
      this.i = bodyStart;
      return { k: "text", parts: [] };
    }
    let end = bodyStart;
    while (end < this.src.length) {
      if (!this.lineIsBlank(end)) {
        let w = 0;
        while (this.src[end + w] === " " || this.src[end + w] === "\t") w++;
        if (w < indent) break;
      }
      end = this.eolIndex(end) + 1;
    }
    end = Math.min(end, this.src.length);

    const saved = this.src;
    // Parse the region as if the source ended at `end`.
    const sub = new Parser(saved.slice(0, end), this.base);
    sub.i = bodyStart;
    let expr: Expr;
    try {
      expr = sub.parseSeq(() => false, false);
      sub.skipWs(true);
      if (sub.i < end) sub.fail("unexpected text in definition");
    } finally {
      this.diagnostics.push(...sub.diagnostics);
    }
    this.i = end;
    return expr;
  }

  // -- Expressions -----------------------------------------------------------

  /**
   * Parse adjacent expressions until `stop` matches. With `eolStops`, a
   * newline outside any nested block also ends the sequence.
   */
  private parseSeq(stop: () => boolean, eolStops: boolean): Expr {
    const items: Expr[] = [];
    for (;;) {
      this.skipWs(!eolStops);
      if (this.i >= this.src.length) break;
      if (eolStops && this.atEol()) break;
      if (stop()) break;
      items.push(this.parseItem());
    }
    return items.length === 1 ? items[0] : { k: "seq", items };
  }

  private parseBlockBody(allowElse: boolean): Expr {
    return this.parseSeq(() => this.isWordAt("end") || (allowElse && this.isWordAt("else")), false);
  }

  private parseItem(): Expr {
    const c = this.src[this.i];
    if (c === '"' || c === "'") return { k: "text", parts: this.parseQuoted() };
    if ((c === "q" || c === "v") && this.isFlexQuoteAt(this.i)) return this.parseFlexQuote();
    if (c === "[" || (c === "!" && this.src[this.i + 1] === "[")) return this.parseBracketExpr();
    if (this.isWordAt("ifdef")) return this.parseIfdef();
    if (this.isWordAt("if")) return this.parseIf();
    if (this.isWordAt("match")) return this.parseMatch();
    if (this.isWordAt("cond")) return this.parseCondCall();
    if (this.isWordAt("join")) return this.parseJoin();
    if (this.isWordAt("style")) return this.parseStyle();
    if (this.isWordAt("else") || this.isWordAt("end")) this.fail(`unexpected '${this.isWordAt("end") ? "end" : "else"}'`);
    this.fail(`unexpected '${c}'`);
  }

  private isFlexQuoteAt(index: number): boolean {
    const d = this.src[index + 1];
    return d !== undefined && !IDENT_CHAR.test(d) && !/\s/.test(d) && d !== '"' && d !== "'";
  }

  /** Extent of a quoted string at `this.i`: returns [contentStart, contentEnd] and advances past it. */
  private scanQuoted(): [number, number] {
    const q = this.src[this.i];
    const start = this.i;
    let j = this.i + 1;
    while (j < this.src.length && this.src[j] !== q) {
      if (this.src[j] === "\\") j++;
      j++;
    }
    if (j >= this.src.length) this.fail("unterminated string", start);
    this.i = j + 1;
    return [start + 1, j];
  }

  private parseQuoted(): TextPart[] {
    const [s, e] = this.scanQuoted();
    return this.parseText(s, e);
  }

  /** Extent of a q/v flexible quote at `this.i`: returns [contentStart, contentEnd]. */
  private scanFlexQuote(): [number, number] {
    const start = this.i;
    const d = this.src[this.i + 1];
    let n = 0;
    while (this.src[this.i + 1 + n] === d) n++;
    const close = (CLOSERS[d] ?? d).repeat(n);
    const afterOpen = this.i + 1 + n;
    if (!/\s/.test(this.src[afterOpen] ?? "")) this.fail("expected a space after the opening quote", afterOpen);
    const contentStart = afterOpen + 1;
    let j = this.src.indexOf(close, afterOpen + 1);
    while (j >= 0 && !/\s/.test(this.src[j - 1])) j = this.src.indexOf(close, j + 1);
    if (j < 0) this.fail(`unterminated quote, expected ' ${close}'`, start);
    this.i = j + close.length;
    return [contentStart, Math.max(contentStart, j - 1)];
  }

  private parseFlexQuote(): Expr {
    const verbatim = this.src[this.i] === "v";
    const [s, e] = this.scanFlexQuote();
    return verbatim ? { k: "verbatim", text: this.src.slice(s, e) } : { k: "text", parts: this.parseText(s, e) };
  }

  /** Raw (unexpanded) content of any string form, for match patterns. */
  private readRawString(): string {
    const c = this.src[this.i];
    if (c === '"' || c === "'") {
      const [s, e] = this.scanQuoted();
      return this.src.slice(s, e).replace(/\\(.)/g, "$1");
    }
    const [s, e] = this.scanFlexQuote();
    return this.src.slice(s, e);
  }

  private isStringStart(): boolean {
    const c = this.src[this.i];
    return c === '"' || c === "'" || ((c === "q" || c === "v") && this.isFlexQuoteAt(this.i));
  }

  private parseBracketExpr(): Expr {
    const start = this.i;
    const open = this.src[this.i] === "!" ? this.i + 1 : this.i;
    const close = this.matchClose(open, this.src.length, "[", "]");
    if (close < 0) this.fail("unclosed '['", start);
    let end = close + 1;
    if (this.src[end] === "(") {
      const p = this.matchClose(end, this.src.length, "(", ")");
      if (p >= 0) end = p + 1;
    }
    this.i = end;
    return { k: "text", parts: this.parseText(start, end) };
  }

  private parseIf(): Expr {
    this.i += 2;
    const cond = this.parseCond();
    this.expectChar(":");
    const then = this.parseBlockBody(true);
    let els: Expr | undefined;
    this.skipWs(true);
    if (this.isWordAt("else")) {
      this.i += 4;
      this.expectChar(":");
      els = this.parseBlockBody(false);
    }
    this.expectWord("end");
    return { k: "if", cond, then, else: els };
  }

  private parseIfdef(): Expr {
    this.i += 5;
    this.expectChar(":");
    const body = this.parseBlockBody(true);
    let els: Expr | undefined;
    this.skipWs(true);
    if (this.isWordAt("else")) {
      this.i += 4;
      this.expectChar(":");
      els = this.parseBlockBody(false);
    }
    this.expectWord("end");
    return { k: "ifdef", body, else: els };
  }

  private parseArgs(): Expr[] {
    this.expectChar("(");
    const args: Expr[] = [];
    for (;;) {
      args.push(this.parseSeq(() => this.src[this.i] === "," || this.src[this.i] === ")", false));
      this.skipWs(true);
      if (this.src[this.i] === ",") { this.i++; continue; }
      if (this.src[this.i] === ")") { this.i++; return args; }
      this.fail("expected ',' or ')'");
    }
  }

  private parseCondCall(): Expr {
    const start = this.i;
    this.i += 4;
    this.expectChar("(");
    const cond = this.parseCond();
    this.expectChar(",");
    const rest: Expr[] = [];
    for (;;) {
      rest.push(this.parseSeq(() => this.src[this.i] === "," || this.src[this.i] === ")", false));
      this.skipWs(true);
      if (this.src[this.i] === ",") { this.i++; continue; }
      if (this.src[this.i] === ")") { this.i++; break; }
      this.fail("expected ',' or ')'");
    }
    if (rest.length > 2) this.fail("cond takes a condition and one or two values", start);
    return { k: "if", cond, then: rest[0], else: rest[1] };
  }

  private parseJoin(): Expr {
    const start = this.i;
    this.i += 4;
    const args = this.parseArgs();
    if (args.length < 1) this.fail("join needs a separator", start);
    return { k: "join", sep: args[0], items: args.slice(1) };
  }

  private parseStyle(): Expr {
    this.i += 5;
    this.expectChar("(");
    const changes: StyleChange[] = [];
    for (;;) {
      this.skipWs(true);
      const sign = this.src[this.i];
      if (sign !== "+" && sign !== "-") this.fail("expected '+name' or '-name'");
      this.i++;
      const s = this.i;
      while (this.i < this.src.length && STYLE_CHAR.test(this.src[this.i])) this.i++;
      if (s === this.i) this.fail("expected a style name");
      changes.push({ add: sign === "+", name: this.src.slice(s, this.i) });
      this.skipWs(true);
      if (this.src[this.i] === ",") { this.i++; continue; }
      if (this.src[this.i] === ")") { this.i++; break; }
      this.fail("expected ',' or ')'");
    }
    this.skipInline();
    if (this.src[this.i] !== ":") return { k: "style", changes };
    this.i++;
    const body = this.parseBlockBody(false);
    this.expectWord("end");
    return { k: "style", changes, body };
  }

  private parseMatch(): Expr {
    const start = this.i;
    this.i += 5;
    this.skipWs(true);
    const subject = this.parseOperand();
    this.expectChar(":");
    const arms: MatchArm[] = [];
    let elseArm: Expr | undefined;
    for (;;) {
      this.skipWs(true);
      if (this.isWordAt("end")) { this.i += 3; break; }
      if (this.i >= this.src.length) this.fail("expected 'end' to close match", start);
      let isElse = false;
      const patterns: MatchPattern[] = [];
      if (this.isWordAt("else")) {
        this.i += 4;
        isElse = true;
      } else {
        for (;;) {
          this.skipWs(true);
          patterns.push(this.parsePattern());
          this.skipWs(true);
          if (this.src[this.i] === ",") { this.i++; continue; }
          break;
        }
      }
      this.skipWs(true);
      if (!this.src.startsWith("=>", this.i)) this.fail("expected '=>'");
      this.i += 2;
      const body = this.parseSeq(() => this.src[this.i] === ".", false);
      this.expectChar(".");
      if (isElse) {
        if (elseArm) this.error("duplicate else arm", start);
        elseArm = body;
      } else {
        arms.push({ patterns, body });
      }
    }
    return { k: "match", subject, arms, elseArm, pos: this.pos(start) };
  }

  private parsePattern(): MatchPattern {
    const start = this.i;
    let globStart = false;
    let globEnd = false;
    if (this.src[this.i] === "*") { globStart = true; this.i++; }
    let value: LiteralValue;
    if (this.isStringStart()) {
      value = { t: "str", v: this.readRawString() };
    } else {
      value = this.parseLiteral();
    }
    if (this.src[this.i] === "*") { globEnd = true; this.i++; }
    if ((globStart || globEnd) && value.t !== "str") this.fail("'*' only applies to string patterns", start);
    return { value, globStart, globEnd, pos: this.pos(start) };
  }

  // -- Conditions ------------------------------------------------------------

  private parseCond(): Cond {
    const first = this.parseUnary();
    let op: "and" | "or" | undefined;
    const items = [first];
    for (;;) {
      this.skipWs(true);
      const w = this.isWordCI("and") ? "and" : this.isWordCI("or") ? "or" : undefined;
      if (!w) break;
      if (op && op !== w) this.fail("mixing AND and OR requires parentheses");
      op = w;
      this.i += w.length;
      items.push(this.parseUnary());
    }
    return op ? { k: op, items } : first;
  }

  private parseUnary(): Cond {
    this.skipWs(true);
    if (this.isWordCI("not")) {
      this.i += 3;
      return { k: "not", c: this.parseUnary() };
    }
    if (this.src[this.i] === "(") {
      this.i++;
      const c = this.parseCond();
      this.expectChar(")");
      return c;
    }
    return this.parseComparison();
  }

  private parseComparison(): Cond {
    const start = this.i;
    if (this.src.startsWith("[?", this.i)) {
      const close = this.src.indexOf("]", this.i);
      if (close < 0) this.fail("unclosed '[?'");
      const inner = this.src.slice(this.i + 1, close);
      const names = inner.split(",").map((s) => s.trim());
      if (!names.every((n) => /^\?[A-Za-z_][A-Za-z0-9_]*$/.test(n))) this.fail("expected [?name] or [?a,?b,...]");
      this.i = close + 1;
      return { k: "set", names: names.map((n) => n.slice(1)), pos: this.pos(start) };
    }
    const left = this.parseOperand();
    this.skipWs(true);
    const op = (["==", "!=", "<=", ">=", "<", ">"] as CmpOp[]).find((o) => this.src.startsWith(o, this.i));
    if (op) {
      this.i += op.length;
      this.skipWs(true);
      const right = this.parseOperand();
      return { k: "cmp", op, left, right, pos: this.pos(start) };
    }
    if (this.isWordAt("in")) {
      this.i += 2;
      this.skipWs(true);
      const hay = this.parseOperand();
      return { k: "in", needle: left, hay, pos: this.pos(start) };
    }
    if (left.k === "attr") return { k: "truthy", name: left.name, pos: left.pos };
    if (left.k === "lit" && left.value.t === "bool") return { k: "lit", value: left.value.v };
    this.fail("expected a condition", start);
  }

  private parseOperand(): Operand {
    this.skipWs(true);
    const start = this.i;
    const pos = this.pos(start);
    if (this.src[this.i] === "@") {
      this.i++;
      return { k: "attr", name: this.readIdent(), pos };
    }
    if (this.isStringStart()) {
      const c = this.src[this.i];
      const expr: Expr = c === '"' || c === "'" ? { k: "text", parts: this.parseQuoted() } : this.parseFlexQuote();
      return { k: "text", expr, pos };
    }
    return { k: "lit", value: this.parseLiteral(), pos };
  }

  private parseLiteral(): LiteralValue {
    const rest = this.src.slice(this.i);
    const dur = /^(?:(\d+)h(?:(\d+)m)?|(\d+)m)(?![A-Za-z0-9_])/.exec(rest);
    if (dur) {
      this.i += dur[0].length;
      const minutes = dur[3] !== undefined ? Number(dur[3]) : Number(dur[1]) * 60 + Number(dur[2] ?? 0);
      return { t: "num", v: minutes };
    }
    const num = /^-?\d+(?:\.\d+)?(?![A-Za-z0-9_])/.exec(rest);
    if (num) {
      this.i += num[0].length;
      return { t: "num", v: Number(num[0]) };
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)?.[0];
    if (word === "true" || word === "false") {
      this.i += word.length;
      return { t: "bool", v: word === "true" };
    }
    if (word && TODO_WORDS.has(word)) {
      this.i += word.length;
      return { t: "todo", v: word };
    }
    if (word) this.fail(`unknown value '${word}' (attributes in conditions are written @${word})`);
    this.fail("expected a value");
  }

  // -- Text mode -------------------------------------------------------------

  parseText(start: number, end: number): TextPart[] {
    const parts: TextPart[] = [];
    let lit = "";
    const flush = () => {
      if (lit) { parts.push({ k: "lit", text: lit }); lit = ""; }
    };
    let j = start;
    while (j < end) {
      const c = this.src[j];
      if (c === "\\" && j + 1 < end) {
        lit += this.src[j + 1];
        j += 2;
        continue;
      }
      if (c === " " && this.src[j + 1] === "?" && this.src[j + 2] === "[" && j + 2 < end) {
        const close = this.matchClose(j + 2, end, "[", "]");
        if (close >= 0) {
          flush();
          const ref = this.parseRef(j + 3, close, true);
          if (ref) parts.push(ref);
          j = close + 1;
          continue;
        }
      }
      if (c === "!" && this.src[j + 1] === "[") {
        const close = this.matchClose(j + 1, end, "[", "]");
        if (close >= 0 && this.src[close + 1] === "(") {
          const p = this.matchClose(close + 1, end, "(", ")");
          if (p >= 0) {
            flush();
            parts.push({ k: "img", alt: this.parseText(j + 2, close), url: this.parseText(close + 2, p) });
            j = p + 1;
            continue;
          }
        }
      }
      if (c === "[") {
        const close = this.matchClose(j, end, "[", "]");
        if (close < 0) {
          this.error("unclosed '[' (write \\[ for a literal bracket)", j);
          lit += c;
          j++;
          continue;
        }
        flush();
        if (this.src[close + 1] === "(" && close + 1 < end) {
          const p = this.matchClose(close + 1, end, "(", ")");
          if (p >= 0) {
            parts.push({ k: "link", text: this.parseText(j + 1, close), url: this.parseText(close + 2, p) });
            j = p + 1;
            continue;
          }
        }
        const ref = this.parseRef(j + 1, close, false);
        if (ref) parts.push(ref);
        else lit += this.src.slice(j, close + 1);
        j = close + 1;
        continue;
      }
      lit += c;
      j++;
    }
    flush();
    return parts;
  }

  /** Parse `name[:variant][/fallback]` between `start` and `end` (exclusive). */
  private parseRef(start: number, end: number, optSpace: boolean): TextPart | null {
    const inner = this.src.slice(start, end);
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_][A-Za-z0-9_]*))?/.exec(inner);
    const rest = m ? inner.slice(m[0].length) : inner;
    if (!m || (rest && rest[0] !== "/")) {
      if (inner.startsWith("?")) this.error("[?name] is only allowed in conditions", start - 1);
      else this.error("invalid reference; expected [name], [name:variant], or [name/fallback] (write \\[ for a literal bracket)", start - 1);
      return null;
    }
    const fallback = rest ? this.parseText(start + m[0].length + 1, end) : undefined;
    return { k: "ref", name: m[1], variant: m[2], fallback, optSpace, pos: this.pos(start - 1) };
  }
}
