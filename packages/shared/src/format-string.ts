import type { AttributeDefinition, Item } from "./types.js";

type Segment =
  | { kind: "literal"; text: string }
  | { kind: "placeholder"; key: string; modifier?: string; modifierArg?: string }
  | { kind: "conditional"; body: Segment[]; fallback: Segment[] }
  | { kind: "ternary"; key: string; trueBranch: Segment[]; falseBranch: Segment[] }
  | { kind: "image"; alt: Segment[]; url: Segment[] };

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

      // Image: ![alt](url) — peek to confirm closing ](
      if (ch === "!" && i + 1 < format.length && format[i + 1] === "[") {
        let j = i + 2;
        while (j < format.length && format[j] !== "]") j++;
        if (j < format.length && j + 1 < format.length && format[j + 1] === "(") {
          if (literal) { result.push({ kind: "literal", text: literal }); literal = ""; }
          i += 2; // skip ![
          const alt = parseSegments("]");
          if (i < format.length && format[i] === "]") i++; // skip ]
          if (i < format.length && format[i] === "(") i++; // skip (
          const url = parseSegments(")");
          if (i < format.length && format[i] === ")") i++; // skip )
          result.push({ kind: "image", alt, url });
          continue;
        }
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
    const isTernary = /^[a-zA-Z_][a-zA-Z0-9_]*:\?/.test(toClose);

    if (isTernary) {
      return parseTernary();
    } else if (isSimplePlaceholder) {
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

  function parseTernary(): Segment {
    let key = "";
    while (i < format.length && /[a-zA-Z0-9_]/.test(format[i])) {
      key += format[i];
      i++;
    }
    i += 2; // skip :?

    const trueBranch = parseSegments(":}");
    let falseBranch: Segment[] = [];

    if (i < format.length && format[i] === ":") {
      i++; // skip :
      falseBranch = parseSegments("}");
    }

    if (i < format.length && format[i] === "}") {
      i++; // skip }
    }

    return { kind: "ternary", key, trueBranch, falseBranch };
  }

  segments.push(...parseSegments(""));
  return segments;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h} hour${h !== 1 ? "s" : ""}`);
  if (m > 0 || h === 0) parts.push(`${m} minute${m !== 1 ? "s" : ""}`);
  return parts.join(" ");
}

function formatValue(
  value: unknown,
  modifier?: string,
  modifierArg?: string,
  customModifiers?: Record<string, ModifierFn>,
  attrType?: string,
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

  if (attrType === "duration" && typeof value === "number") return formatDuration(value);
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

function collectPlaceholderKeys(segments: Segment[], keys: Set<string>): void {
  for (const seg of segments) {
    if (seg.kind === "placeholder") keys.add(seg.key);
    else if (seg.kind === "conditional") {
      collectPlaceholderKeys(seg.body, keys);
      collectPlaceholderKeys(seg.fallback, keys);
    } else if (seg.kind === "ternary") {
      keys.add(seg.key);
      collectPlaceholderKeys(seg.trueBranch, keys);
      collectPlaceholderKeys(seg.falseBranch, keys);
    } else if (seg.kind === "image") {
      collectPlaceholderKeys(seg.alt, keys);
      collectPlaceholderKeys(seg.url, keys);
    }
  }
}

function detectMacroCycle(macros: Record<string, string>): string | null {
  const macroNames = new Set(Object.keys(macros));
  const deps: Record<string, Set<string>> = {};
  for (const [name, fmt] of Object.entries(macros)) {
    const keys = new Set<string>();
    collectPlaceholderKeys(parseFormatString(fmt), keys);
    deps[name] = new Set([...keys].filter((k) => macroNames.has(k)));
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  function dfs(node: string): string | null {
    if (stack.has(node)) return node;
    if (visited.has(node)) return null;
    stack.add(node);
    for (const dep of deps[node] ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    stack.delete(node);
    visited.add(node);
    return null;
  }
  for (const name of macroNames) {
    const cycle = dfs(name);
    if (cycle) return `Macro cycle detected involving "${cycle}"`;
  }
  return null;
}

function renderSegments(
  segments: Segment[],
  item: Item,
  customModifiers?: Record<string, ModifierFn>,
  strict?: boolean,
  schemaMap?: Map<string, AttributeDefinition>,
  macros?: Record<string, string>,
  visiting?: Set<string>,
  html?: boolean,
  urlResolver?: (url: string) => string,
): string | null {
  let result = "";
  for (const seg of segments) {
    switch (seg.kind) {
      case "literal":
        result += seg.text;
        break;

      case "placeholder": {
        if (!hasValue(item, seg.key, schemaMap)) {
          if (macros && seg.key in macros && !visiting?.has(seg.key)) {
            const visiting2 = new Set(visiting);
            visiting2.add(seg.key);
            const expanded = renderSegments(
              parseFormatString(macros[seg.key]),
              item, customModifiers, strict, schemaMap, macros, visiting2, html, urlResolver,
            );
            if (expanded !== null && expanded !== "") {
              result += expanded;
            } else if (strict) {
              return null;
            } else if (seg.modifier === "fallback") {
              result += html ? escapeHtml(seg.modifierArg ?? "") : (seg.modifierArg ?? "");
            }
          } else if (seg.modifier === "fallback") {
            result += html ? escapeHtml(seg.modifierArg ?? "") : (seg.modifierArg ?? "");
          } else if (strict) {
            return null;
          }
        } else {
          const val = formatValue(getValue(item, seg.key, schemaMap), seg.modifier, seg.modifierArg, customModifiers, schemaMap?.get(seg.key)?.type);
          result += html ? escapeHtml(val) : val;
        }
        break;
      }

      case "conditional": {
        const bodyResult = renderSegments(seg.body, item, customModifiers, true, schemaMap, macros, visiting, html, urlResolver);
        if (bodyResult !== null) {
          result += bodyResult;
        } else {
          const fallbackResult = renderSegments(seg.fallback, item, customModifiers, true, schemaMap, macros, visiting, html, urlResolver);
          if (fallbackResult !== null) {
            result += fallbackResult;
          }
        }
        break;
      }

      case "ternary": {
        const val = getValue(item, seg.key, schemaMap);
        const branch = val ? seg.trueBranch : seg.falseBranch;
        const branchResult = renderSegments(branch, item, customModifiers, strict, schemaMap, macros, visiting, html, urlResolver);
        if (branchResult !== null) {
          result += branchResult;
        } else if (strict) {
          return null;
        }
        break;
      }

      case "image": {
        const altText = renderSegments(seg.alt, item, customModifiers, false, schemaMap, macros, visiting, true, urlResolver) ?? "";
        if (html) {
          const urlText = renderSegments(seg.url, item, customModifiers, false, schemaMap, macros, visiting, true, urlResolver) ?? "";
          const resolvedUrl = urlResolver ? urlResolver(urlText) : urlText;
          result += `<img src="${resolvedUrl}" alt="${altText}">`;
        } else {
          result += altText;
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
  macros?: Record<string, string>,
): string {
  const schemaMap = new Map(schema?.map((d) => [d.key, d]));
  const segments = parseFormatString(format);
  return renderSegments(segments, item, customModifiers, false, schemaMap, macros) ?? item.title;
}

export function renderFormatStringHtml(
  format: string,
  item: Item,
  schema?: AttributeDefinition[],
  customModifiers?: Record<string, ModifierFn>,
  macros?: Record<string, string>,
  urlResolver?: (url: string) => string,
): string {
  const schemaMap = new Map(schema?.map((d) => [d.key, d]));
  const segments = parseFormatString(format);
  return renderSegments(segments, item, customModifiers, false, schemaMap, macros, undefined, true, urlResolver) ?? escapeHtml(item.title);
}

export function validateFormatString(format: string, macros?: Record<string, string>): string | null {
  let depth = 0;
  for (let i = 0; i < format.length; i++) {
    if (format[i] === "{" && i + 1 < format.length && format[i + 1] === "{") { i++; continue; }
    if (format[i] === "}" && i + 1 < format.length && format[i + 1] === "}") { i++; continue; }
    if (format[i] === "{") depth++;
    else if (format[i] === "}") {
      if (--depth < 0) return "Unexpected '}'";
    }
  }
  if (depth > 0) return "Unclosed '{'";
  if (macros) {
    for (const [name, macroFormat] of Object.entries(macros)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return `Invalid macro name: "${name}"`;
      const macroErr = validateFormatString(macroFormat);
      if (macroErr) return `Error in macro "${name}": ${macroErr}`;
    }
    return detectMacroCycle(macros);
  }
  return null;
}

export function parseAdvancedFormatText(text: string): {
  format: string;
  macros: Record<string, string>;
  error: string | null;
} {
  const lines = text.split("\n");
  const format = lines[0] ?? "";
  const macros: Record<string, string> = {};
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx < 1) {
      errors.push(`Line ${i + 1}: expected "name=format", got "${line.trim()}"`);
      continue;
    }
    const name = line.substring(0, eqIdx).trim();
    const value = line.substring(eqIdx + 1);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      errors.push(`Line ${i + 1}: invalid macro name "${name}"`);
      continue;
    }
    macros[name] = value;
  }
  if (errors.length > 0) return { format, macros, error: errors.join("\n") };
  return { format, macros, error: validateFormatString(format, macros) };
}

export function serializeAdvancedFormatText(format: string, macros?: Record<string, string>): string {
  if (!macros || Object.keys(macros).length === 0) return format;
  return [format, ...Object.entries(macros).map(([k, v]) => `${k}=${v}`)].join("\n");
}
