import type { AttributeDefinition, Item } from "./types.js";

type Segment =
  | { kind: "literal"; text: string }
  | { kind: "placeholder"; key: string; modifier?: string; modifierArg?: string }
  | { kind: "conditional"; body: Segment[]; fallback: Segment[] };

export function parseFormatString(format: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;

  function parseSegments(stopChars: string): Segment[] {
    const result: Segment[] = [];
    let literal = "";

    while (i < format.length) {
      const ch = format[i];

      if (stopChars.includes(ch)) {
        break;
      }

      if (ch === "{") {
        if (i + 1 < format.length && format[i + 1] === "{") {
          literal += "{";
          i += 2;
          continue;
        }

        if (literal) {
          result.push({ kind: "literal", text: literal });
          literal = "";
        }

        i++; // skip {
        const inner = parseInner();
        if (inner) result.push(inner);
        continue;
      }

      if (ch === "}" && i + 1 < format.length && format[i + 1] === "}") {
        literal += "}";
        i += 2;
        continue;
      }

      literal += ch;
      i++;
    }

    if (literal) {
      result.push({ kind: "literal", text: literal });
    }

    return result;
  }

  function parseInner(): Segment | null {
    const start = i;

    // Check if this is a conditional section (starts with space or non-identifier char before any placeholder)
    // Conditional: { content_with_placeholders | fallback }
    // Placeholder: {key} or {key:modifier}
    // Distinguish: if we see a | before }, it's conditional

    // Peek ahead to determine if this is a placeholder or conditional
    let j = start;
    let depth = 0;
    let hasPipe = false;
    while (j < format.length) {
      if (format[j] === "{") depth++;
      if (format[j] === "}" && depth > 0) { depth--; }
      else if (format[j] === "}" && depth === 0) break;
      if (format[j] === "|" && depth === 0) { hasPipe = true; break; }
      j++;
    }

    // Also check: a simple placeholder has only identifier chars and optional :modifier
    const toClose = format.substring(start, j);
    const isSimplePlaceholder = !hasPipe && /^[a-zA-Z_][a-zA-Z0-9_]*(:[a-zA-Z_]+(=[^}]*)?)?$/.test(toClose);

    if (isSimplePlaceholder) {
      return parsePlaceholder();
    } else {
      return parseConditional();
    }
  }

  function parsePlaceholder(): Segment {
    let key = "";
    while (i < format.length && /[a-zA-Z0-9_]/.test(format[i])) {
      key += format[i];
      i++;
    }

    let modifier: string | undefined;
    let modifierArg: string | undefined;

    if (i < format.length && format[i] === ":") {
      i++; // skip :
      modifier = "";
      while (i < format.length && /[a-zA-Z_]/.test(format[i])) {
        modifier += format[i];
        i++;
      }
      if (i < format.length && format[i] === "=") {
        i++; // skip =
        modifierArg = "";
        while (i < format.length && format[i] !== "}") {
          modifierArg += format[i];
          i++;
        }
      }
    }

    if (i < format.length && format[i] === "}") {
      i++; // skip }
    }

    return { kind: "placeholder", key, modifier, modifierArg };
  }

  function parseConditional(): Segment {
    const body = parseSegments("|}");
    let fallback: Segment[] = [];

    if (i < format.length && format[i] === "|") {
      i++; // skip |
      fallback = parseSegments("}");
    }

    if (i < format.length && format[i] === "}") {
      i++; // skip }
    }

    return { kind: "conditional", body, fallback };
  }

  segments.push(...parseSegments(""));
  return segments;
}

type ModifierFn = (value: unknown, arg?: string) => string;

const builtinModifiers: Record<string, ModifierFn> = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  fallback: (v, arg) => (v != null && v !== "" ? formatValue(v) : arg ?? ""),
  stars: (v) => {
    const n = Number(v);
    if (isNaN(n)) return String(v);
    const full = Math.round(n);
    return "★".repeat(Math.min(full, 10)) + "☆".repeat(Math.max(0, 5 - full));
  },
  short: (v) => {
    if (typeof v === "number") {
      const h = Math.floor(v / 60);
      const m = v % 60;
      if (h > 0) return m > 0 ? `${h}h${m}m` : `${h}h`;
      return `${m}m`;
    }
    if (v instanceof Date) {
      return v.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
    return String(v);
  },
  long: (v) => {
    if (typeof v === "number") {
      const h = Math.floor(v / 60);
      const m = v % 60;
      const parts: string[] = [];
      if (h > 0) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
      if (m > 0) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
      return parts.join(" ") || "0 minutes";
    }
    if (v instanceof Date) {
      return v.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    }
    return String(v);
  },
};

function formatValue(
  value: unknown,
  modifier?: string,
  modifierArg?: string,
  customModifiers?: Record<string, ModifierFn>,
): string {
  if (value == null) return "";

  if (modifier) {
    const fn = customModifiers?.[modifier] ?? builtinModifiers[modifier];
    if (fn) {
      const result = fn(value, modifierArg);
      if (result !== "" || modifier !== "fallback") return result;
      return modifierArg ?? "";
    }
  }

  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function getValue(item: Item, key: string, schemaMap?: Map<string, AttributeDefinition>): unknown {
  if (key === "title") return item.title;
  if (key === "created_at") return new Date(item.created_at);
  if (key === "updated_at") return new Date(item.updated_at);
  const v = item.attributes[key];
  if (v === undefined && schemaMap) {
    const def = schemaMap.get(key);
    if (def?.type === "boolean") return false;
  }
  return v;
}

function hasValue(item: Item, key: string, schemaMap?: Map<string, AttributeDefinition>): boolean {
  const v = getValue(item, key, schemaMap);
  return v != null && v !== "";
}

function renderSegments(
  segments: Segment[],
  item: Item,
  customModifiers?: Record<string, ModifierFn>,
  strict?: boolean,
  schemaMap?: Map<string, AttributeDefinition>,
): string | null {
  let result = "";
  for (const seg of segments) {
    switch (seg.kind) {
      case "literal":
        result += seg.text;
        break;

      case "placeholder": {
        if (!hasValue(item, seg.key, schemaMap)) {
          if (seg.modifier === "fallback") {
            result += seg.modifierArg ?? "";
          } else if (strict) {
            return null;
          }
        } else {
          result += formatValue(getValue(item, seg.key, schemaMap), seg.modifier, seg.modifierArg, customModifiers);
        }
        break;
      }

      case "conditional": {
        const bodyResult = renderSegments(seg.body, item, customModifiers, true, schemaMap);
        if (bodyResult !== null) {
          result += bodyResult;
        } else {
          const fallbackResult = renderSegments(seg.fallback, item, customModifiers, true, schemaMap);
          if (fallbackResult !== null) {
            result += fallbackResult;
          }
        }
        break;
      }
    }
  }
  return result;
}

export function renderFormatString(
  format: string,
  item: Item,
  schema?: AttributeDefinition[],
  customModifiers?: Record<string, ModifierFn>,
): string {
  const schemaMap = new Map(schema?.map((d) => [d.key, d]));
  const segments = parseFormatString(format);
  return renderSegments(segments, item, customModifiers, false, schemaMap) ?? item.title;
}
