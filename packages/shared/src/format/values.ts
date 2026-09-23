// Per-type value semantics for the format language: set vs. truthy, default
// rendering, `:variant` forms, and typed comparison.

import type { AttributeDefinition, AttributeType, Item } from "../types.js";
import type { CmpOp, LiteralValue } from "./ast.js";

export type ValueType = "str" | "num" | "bool" | "todo" | "date" | "tags";

export interface TypedValue {
  t: ValueType | "none";
  v: unknown;
}

export const BUILTIN_TYPES: Record<string, AttributeType> = {
  title: "text",
  created_at: "datetime",
  updated_at: "datetime",
};

export const TODO_ICONS: Record<string, string> = {
  unchecked: "\u2610",
  done: "\u2611",
  cancelled: "\u229f",
  skipped: "( )",
};

export function valueTypeOf(t: AttributeType): ValueType {
  switch (t) {
    case "number":
    case "integer":
    case "duration":
      return "num";
    case "boolean":
      return "bool";
    case "todo":
      return "todo";
    case "date":
    case "datetime":
      return "date";
    case "tags":
      return "tags";
    default:
      return "str";
  }
}

/** Unset means undefined, null, "", [], or NaN. Everything else is set, including 0 and false. */
export function isSet(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "number") return !Number.isNaN(v);
  return true;
}

export function isTruthy(v: unknown): boolean {
  return isSet(v) && v !== 0 && v !== false;
}

export function attrType(key: string, schema: Map<string, AttributeDefinition>): AttributeType | undefined {
  return BUILTIN_TYPES[key] ?? schema.get(key)?.type;
}

/** The stored value of an attribute, with absent booleans read as false. */
export function rawValue(item: Item, key: string, type: AttributeType | undefined): unknown {
  if (key === "title") return item.title;
  if (key === "created_at") return new Date(item.created_at).toISOString();
  if (key === "updated_at") return new Date(item.updated_at).toISOString();
  const v = item.attributes[key];
  if (type === "boolean" && v == null) return false;
  return v;
}

export function typedValue(raw: unknown, type: AttributeType | undefined): TypedValue {
  if (type === "todo") return { t: "todo", v: isSet(raw) ? String(raw) : "unchecked" };
  if (!isSet(raw)) return { t: "none", v: undefined };
  return { t: type ? valueTypeOf(type) : "str", v: raw };
}

export function literalTyped(lit: LiteralValue): TypedValue {
  return { t: lit.t, v: lit.v };
}

// -- Rendering ----------------------------------------------------------------

export function formatDurationLong(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  if (m > 0 || h === 0) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

export function formatDurationShort(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
  return `${m}m`;
}

/** Parse "1h42m", "2h", "90m", or bare minutes. Returns null for anything else. */
export function parseDurationText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const hm = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m?)?$/i.exec(trimmed);
  if (hm && (hm[1] !== undefined || hm[2] !== undefined)) {
    return Number(hm[1] ?? 0) * 60 + Number(hm[2] ?? 0);
  }
  return null;
}

/** Parse a stored date or datetime string, treating a bare date as local time. */
function parseDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function defaultString(v: unknown, type: AttributeType | undefined, key: string): string {
  if (type === "duration" && typeof v === "number") return formatDurationLong(v);
  if (type === "todo") return TODO_ICONS[isSet(v) ? String(v) : "unchecked"] ?? String(v);
  if ((key === "created_at" || key === "updated_at") && typeof v === "string") {
    return parseDate(v)?.toLocaleDateString() ?? v;
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

function strForm(v: unknown, type: AttributeType | undefined): string {
  if (type === "todo") return isSet(v) ? String(v) : "unchecked";
  if (type === "duration" && typeof v === "number") return formatDurationShort(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

/** Variants valid for each value type. Variants not listed here are valid for every type. */
const TYPED_VARIANTS: Record<string, (type: AttributeType) => boolean> = {
  stars: (t) => t === "number" || t === "integer",
  short: (t) => t === "duration" || t === "date" || t === "datetime",
};
const ANY_VARIANTS = new Set(["str", "url", "upper", "lower"]);

export function variantError(variant: string, type: AttributeType | undefined): string | null {
  if (ANY_VARIANTS.has(variant)) return null;
  const check = TYPED_VARIANTS[variant];
  if (!check) return `unknown variant ':${variant}'`;
  if (!type || !check(type)) return `':${variant}' does not apply to ${type ?? "derived"} values`;
  return null;
}

export function isTextVariant(variant: string): boolean {
  return ANY_VARIANTS.has(variant);
}

/** Render an attribute value. The caller handles unset values other than todo. */
export function renderValue(v: unknown, type: AttributeType | undefined, key: string, variant?: string): string {
  switch (variant) {
    case undefined:
      return defaultString(v, type, key);
    case "str":
      return strForm(v, type);
    case "url":
      return encodeURIComponent(strForm(v, type));
    case "upper":
      return defaultString(v, type, key).toUpperCase();
    case "lower":
      return defaultString(v, type, key).toLowerCase();
    case "stars": {
      const n = Number(v);
      if (Number.isNaN(n)) return String(v);
      const full = Math.max(0, Math.min(Math.round(n), 10));
      return "\u2605".repeat(full) + "\u2606".repeat(Math.max(0, 5 - full));
    }
    case "short": {
      if (typeof v === "number") return formatDurationShort(v);
      const d = parseDate(v);
      return d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : String(v);
    }
    default:
      return defaultString(v, type, key);
  }
}

// -- Comparison ---------------------------------------------------------------

export function typesComparable(a: ValueType, b: ValueType, op: CmpOp): boolean {
  if (a !== b) return false;
  if (op === "==" || op === "!=") return true;
  return a === "num" || a === "str" || a === "date";
}

export function compare(op: CmpOp, a: TypedValue, b: TypedValue): boolean {
  if (a.t === "none" || b.t === "none") {
    const same = a.t === b.t;
    if (op === "==") return same;
    if (op === "!=") return !same;
    return false;
  }
  if (!typesComparable(a.t, b.t, op)) return false;
  if (a.t === "tags") {
    const eq = JSON.stringify(a.v) === JSON.stringify(b.v);
    return op === "==" ? eq : !eq;
  }
  const x = a.v as number | string | boolean;
  const y = b.v as number | string | boolean;
  switch (op) {
    case "==": return x === y;
    case "!=": return x !== y;
    case "<": return x < y;
    case "<=": return x <= y;
    case ">": return x > y;
    case ">=": return x >= y;
  }
}

export function contains(needle: TypedValue, hay: TypedValue): boolean {
  if (needle.t === "none") return false;
  if (hay.t === "tags" && Array.isArray(hay.v)) return hay.v.includes(needle.v);
  if (hay.t === "str" && typeof needle.v === "string") return String(hay.v).includes(needle.v);
  return false;
}
