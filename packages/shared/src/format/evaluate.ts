// Evaluate a parsed format program against an item, producing styled runs.

import type { AttributeDefinition, Item } from "../types.js";
import type { Cond, Expr, Operand, Program, TextPart } from "./ast.js";
import {
  attrType, compare, contains, isSet, isTruthy, literalTyped, rawValue, renderValue, typedValue,
  type TypedValue,
} from "./values.js";

/** A piece of output. `raw` runs are HTML fragments; others are plain text. */
export interface Run {
  text: string;
  raw: boolean;
  styles: string[];
}

export interface RenderOptions {
  /** Rewrite link and image URLs, eg `hash://...` to `blob:...`. */
  urlResolver?: (url: string) => string;
}

const MAX_DEPTH = 64;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function isEmptyRuns(runs: Run[]): boolean {
  return runs.every((r) => r.text.trim() === "");
}

/** Plain text of some runs, with HTML tags dropped. */
export function plainText(runs: Run[]): string {
  return runs.map((r) => (r.raw ? r.text.replace(/<[^>]*>/g, "") : r.text)).join("");
}

/** Serialize runs to HTML, wrapping each stretch of styled text in a span. */
export function runsToHtml(runs: Run[]): string {
  let html = "";
  let open = "";
  for (const run of runs) {
    const key = run.styles.join(" ");
    if (key !== open) {
      if (open) html += "</span>";
      if (key) html += `<span class="${run.styles.map((s) => `fmt-${s}`).join(" ")}">`;
      open = key;
    }
    html += run.raw ? run.text : escapeHtml(run.text);
  }
  if (open) html += "</span>";
  return html;
}

/** Refs that `ifdef` checks: those used directly in the body without their own fallback. */
function collectRequiredRefs(expr: Expr, out: Set<string>): void {
  const fromText = (parts: TextPart[]) => {
    for (const p of parts) {
      if (p.k === "ref" && !p.fallback && !p.optSpace) out.add(p.name);
      else if (p.k === "link") { fromText(p.text); fromText(p.url); }
      else if (p.k === "img") { fromText(p.alt); fromText(p.url); }
    }
  };
  switch (expr.k) {
    case "text": fromText(expr.parts); break;
    case "seq": expr.items.forEach((e) => collectRequiredRefs(e, out)); break;
    case "style": if (expr.body) collectRequiredRefs(expr.body, out); break;
    default: break;
  }
}

export class Evaluator {
  private styles = new Set<string>();
  private depth = 0;

  constructor(
    private readonly program: Program,
    private readonly item: Item,
    private readonly schema: Map<string, AttributeDefinition>,
    private readonly opts: RenderOptions,
  ) {}

  renderToplevel(): Run[] {
    const out: Run[] = [];
    const wrap = this.program.wrap;
    if (wrap) {
      this.evalExpr(wrap.body, out, new Map([[wrap.name, this.program.toplevel]]));
    } else {
      this.evalText(this.program.toplevel, out, new Map());
    }
    return out;
  }

  renderTooltip(): string | undefined {
    if (!this.program.tooltip) return undefined;
    this.styles = new Set();
    const out: Run[] = [];
    this.evalExpr(this.program.tooltip, out, new Map());
    return plainText(out).trim() || undefined;
  }

  // -- Helpers ---------------------------------------------------------------

  private emit(out: Run[], text: string, raw: boolean): void {
    if (text) out.push({ text, raw, styles: [...this.styles].sort() });
  }

  private isAttribute(name: string): boolean {
    return attrType(name, this.schema) !== undefined;
  }

  /** Evaluate without letting style changes escape. */
  private sandbox(fn: (out: Run[]) => void): Run[] {
    const saved = new Set(this.styles);
    const out: Run[] = [];
    fn(out);
    this.styles = saved;
    return out;
  }

  /** Evaluate a derived attribute or wrap binding in place. Returns false if `name` is neither. */
  private evalNamed(name: string, out: Run[], locals: Map<string, TextPart[]>): boolean {
    if (this.depth > MAX_DEPTH) return true;
    const local = locals.get(name);
    const def = this.isAttribute(name) ? undefined : this.program.defs.get(name);
    if (!local && !def) return false;
    this.depth++;
    try {
      if (local) this.evalText(local, out, new Map());
      else this.evalExpr(def!.expr, out, new Map());
    } finally {
      this.depth--;
    }
    return true;
  }

  /** Whether `name` is set: an attribute with a value, or a derived value that renders non-empty. */
  private nameIsSet(name: string, locals: Map<string, TextPart[]>): boolean {
    if (this.isAttribute(name)) {
      const type = attrType(name, this.schema);
      return isSet(rawValue(this.item, name, type));
    }
    const runs = this.sandbox((out) => this.evalNamed(name, out, locals));
    return !isEmptyRuns(runs);
  }

  // -- Text ------------------------------------------------------------------

  evalText(parts: TextPart[], out: Run[], locals: Map<string, TextPart[]>): void {
    for (const part of parts) {
      switch (part.k) {
        case "lit":
          this.emit(out, part.text, true);
          break;
        case "ref":
          this.evalRef(part, out, locals);
          break;
        case "link": {
          const url = this.resolveUrl(part.url, locals);
          this.emit(out, `<a href="${escapeHtml(url)}">`, true);
          this.evalText(part.text, out, locals);
          this.emit(out, "</a>", true);
          break;
        }
        case "img": {
          const url = this.resolveUrl(part.url, locals);
          const alt = plainText(this.sandbox((o) => this.evalText(part.alt, o, locals)));
          this.emit(out, `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}">`, true);
          break;
        }
      }
    }
  }

  private resolveUrl(parts: TextPart[], locals: Map<string, TextPart[]>): string {
    const runs = this.sandbox((o) => this.evalText(parts, o, locals));
    const url = runs.map((r) => r.text).join("").trim();
    return this.opts.urlResolver ? this.opts.urlResolver(url) : url;
  }

  private evalRef(ref: Extract<TextPart, { k: "ref" }>, out: Run[], locals: Map<string, TextPart[]>): void {
    let value: Run[] = [];
    let set: boolean;
    const type = attrType(ref.name, this.schema);
    if (type !== undefined) {
      const raw = rawValue(this.item, ref.name, type);
      set = isSet(raw);
      if (set || (type === "todo" && !ref.fallback)) {
        this.emit(value, renderValue(raw, type, ref.name, ref.variant), false);
      }
    } else {
      this.evalNamed(ref.name, value, locals);
      if (ref.variant) value = this.applyTextVariant(value, ref.variant);
      set = !isEmptyRuns(value);
    }
    if (!set && ref.fallback) {
      value = [];
      this.evalText(ref.fallback, value, locals);
    }
    if (value.length === 0) return;
    if (ref.optSpace) this.emit(out, " ", false);
    out.push(...value);
  }

  private applyTextVariant(runs: Run[], variant: string): Run[] {
    switch (variant) {
      case "upper": return runs.map((r) => (r.raw ? r : { ...r, text: r.text.toUpperCase() }));
      case "lower": return runs.map((r) => (r.raw ? r : { ...r, text: r.text.toLowerCase() }));
      case "url": {
        const text = plainText(runs);
        return text ? [{ text: encodeURIComponent(text), raw: false, styles: runs[0].styles }] : [];
      }
      case "str": {
        const text = plainText(runs);
        return text ? [{ text, raw: false, styles: runs[0].styles }] : [];
      }
      default: return runs;
    }
  }

  // -- Expressions -----------------------------------------------------------

  evalExpr(expr: Expr, out: Run[], locals: Map<string, TextPart[]>): void {
    switch (expr.k) {
      case "text":
        this.evalText(expr.parts, out, locals);
        break;
      case "verbatim":
        this.emit(out, expr.text, true);
        break;
      case "seq":
        for (const e of expr.items) this.evalExpr(e, out, locals);
        break;
      case "if":
        if (this.evalCond(expr.cond, locals)) this.evalExpr(expr.then, out, locals);
        else if (expr.else) this.evalExpr(expr.else, out, locals);
        break;
      case "ifdef": {
        const refs = new Set<string>();
        collectRequiredRefs(expr.body, refs);
        const ok = [...refs].every((n) => this.nameIsSet(n, locals));
        if (ok) this.evalExpr(expr.body, out, locals);
        else if (expr.else) this.evalExpr(expr.else, out, locals);
        break;
      }
      case "match": {
        const subject = this.operandValue(expr.subject, locals);
        const arm = expr.arms.find((a) => a.patterns.some((p) => {
          const pat = literalTyped(p.value);
          if (pat.t === "str" && subject.t === "str" && (p.globStart || p.globEnd)) {
            const s = String(subject.v);
            const v = String(pat.v);
            if (p.globStart && p.globEnd) return s.includes(v);
            return p.globStart ? s.endsWith(v) : s.startsWith(v);
          }
          return compare("==", subject, pat);
        }));
        const body = arm?.body ?? expr.elseArm;
        if (body) this.evalExpr(body, out, locals);
        break;
      }
      case "join": {
        const pieces = expr.items
          .map((e) => { const o: Run[] = []; this.evalExpr(e, o, locals); return o; })
          .filter((o) => !isEmptyRuns(o));
        pieces.forEach((p, idx) => {
          if (idx > 0) this.evalExpr(expr.sep, out, locals);
          out.push(...p);
        });
        break;
      }
      case "style": {
        const saved = expr.body ? new Set(this.styles) : undefined;
        for (const c of expr.changes) {
          if (c.add) this.styles.add(c.name);
          else this.styles.delete(c.name);
        }
        if (expr.body) {
          this.evalExpr(expr.body, out, locals);
          this.styles = saved!;
        }
        break;
      }
    }
  }

  // -- Conditions ------------------------------------------------------------

  private operandValue(op: Operand, locals: Map<string, TextPart[]>): TypedValue {
    switch (op.k) {
      case "attr": {
        const type = attrType(op.name, this.schema);
        return typedValue(rawValue(this.item, op.name, type), type);
      }
      case "lit":
        return literalTyped(op.value);
      case "text": {
        const runs = this.sandbox((o) => this.evalExpr(op.expr, o, locals));
        return { t: "str", v: plainText(runs) };
      }
    }
  }

  evalCond(cond: Cond, locals: Map<string, TextPart[]>): boolean {
    switch (cond.k) {
      case "truthy": {
        const type = attrType(cond.name, this.schema);
        if (type === undefined) return false;
        return isTruthy(rawValue(this.item, cond.name, type));
      }
      case "set":
        return cond.names.every((n) => this.nameIsSet(n, locals));
      case "lit":
        return cond.value;
      case "cmp":
        return compare(cond.op, this.operandValue(cond.left, locals), this.operandValue(cond.right, locals));
      case "in":
        return contains(this.operandValue(cond.needle, locals), this.operandValue(cond.hay, locals));
      case "not":
        return !this.evalCond(cond.c, locals);
      case "and":
        return cond.items.every((c) => this.evalCond(c, locals));
      case "or":
        return cond.items.some((c) => this.evalCond(c, locals));
    }
  }
}
