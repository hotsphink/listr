// Convert the legacy `{key}` format syntax (and its macros) to the current
// format language. The conversion is deterministic, because the client's
// Dexie upgrade and the server's migration must produce identical text.

const SIMPLE_RE = /^([a-zA-Z_][a-zA-Z0-9_]*)(?::([a-zA-Z_]+)(?:=(.*))?)?$/s;
const TERNARY_RE = /^([a-zA-Z_][a-zA-Z0-9_]*):\?/;
const LINK_RE = /^!?\[[^\]]*\]\([^)]*\)/;
const KEPT_MODIFIERS = new Set(["upper", "lower", "url", "stars", "short"]);
const QUOTES: [string, string][] = [["(", ")"], ["<", ">"], ["{", "}"], ["[", "]"], ["/", "/"], ["|", "|"]];

function escapeLiteral(s: string): string {
  return s.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/** Whether `closer` occurs in `s` right after whitespace, which would end a q-string early. */
function closesEarly(s: string, closer: string): boolean {
  for (let k = s.indexOf(closer, 1); k >= 0; k = s.indexOf(closer, k + 1)) {
    if (/\s/.test(s[k - 1])) return true;
  }
  return false;
}

/** Quote converted text as a q-string that its own content cannot close. */
function quote(text: string): string {
  if (text === "") return '""';
  for (let n = 1; ; n++) {
    for (const [open, close] of QUOTES) {
      const closer = close.repeat(n);
      if (!closesEarly(` ${text}`, closer)) return `q${open.repeat(n)} ${text} ${closer}`;
    }
  }
}

/** Index of the `}` closing the `{` at `start`, or -1. */
function matchBrace(src: string, start: number): number {
  let depth = 0;
  for (let j = start; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return j;
  }
  return -1;
}

/** Index of the first `ch` at brace depth 0 in `s` and outside `![..](..)` images, or -1. */
function findTopLevel(s: string, ch: string): number {
  let depth = 0;
  for (let j = 0; j < s.length; j++) {
    const img = s[j] === "!" ? /^!\[[^\]]*\]\([^)]*\)/.exec(s.slice(j)) : null;
    if (img) j += img[0].length - 1;
    else if (s[j] === "{") depth++;
    else if (s[j] === "}") depth--;
    else if (s[j] === ch && depth === 0) return j;
  }
  return -1;
}

class Converter {
  readonly defs: string[] = [];
  private counter = 0;

  constructor(private readonly macroNames: Set<string>, private readonly prefix: string) {}

  private define(body: string): string {
    const name = `${this.prefix}${++this.counter}`;
    this.defs.push(`${name}=${body}`);
    return `[${name}]`;
  }

  convertText(src: string): string {
    let out = "";
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "{" && src[i + 1] === "{") { out += "{"; i += 2; continue; }
      if (c === "}" && src[i + 1] === "}") { out += "}"; i += 2; continue; }
      if (c === "{") {
        const close = matchBrace(src, i);
        if (close < 0) { out += "{"; i++; continue; }
        out += this.convertInner(src.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      if (c === "\\") { out += "\\\\"; i++; continue; }
      if (c === "?" && src[i + 1] === "[") { out += "\\?"; i++; continue; }
      if (c === "!" && LINK_RE.test(src.slice(i))) { out += "!["; i += 2; continue; }
      if (c === "[") {
        out += LINK_RE.test(src.slice(i)) ? "[" : "\\[";
        i++;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  private convertInner(inner: string): string {
    const ternary = TERNARY_RE.exec(inner);
    if (ternary) {
      const key = ternary[1];
      const rest = inner.slice(ternary[0].length);
      const colon = findTopLevel(rest, ":");
      const yes = colon < 0 ? rest : rest.slice(0, colon);
      const no = colon < 0 ? "" : rest.slice(colon + 1);
      const cond = this.macroNames.has(key) ? `[?${key}]` : `@${key}`;
      const noArg = no === "" ? "" : `, ${quote(this.convertText(no))}`;
      return this.define(`cond(${cond}, ${quote(this.convertText(yes))}${noArg})`);
    }

    const pipe = findTopLevel(inner, "|");
    const simple = pipe < 0 ? SIMPLE_RE.exec(inner) : null;
    if (simple) {
      const [, key, modifier, arg] = simple;
      if (modifier === "fallback") return `[${key}/${escapeLiteral(arg ?? "")}]`;
      if (modifier && KEPT_MODIFIERS.has(modifier)) return `[${key}:${modifier}]`;
      return `[${key}]`;
    }

    const body = pipe < 0 ? inner : inner.slice(0, pipe);
    const fallback = pipe < 0 ? "" : inner.slice(pipe + 1);
    const els = fallback === "" ? "" : ` else: ${quote(this.convertText(fallback))}`;
    return this.define(`ifdef: ${quote(this.convertText(body))}${els} end`);
  }
}

/** Convert a legacy format string plus its macros to format language text. */
export function convertLegacyFormat(formatString: string | null | undefined, macros?: Record<string, string> | null): string {
  const macroEntries = Object.entries(macros ?? {});
  const conv = new Converter(new Set(macroEntries.map(([k]) => k)), "legacy_");
  const toplevel = conv.convertText((formatString ?? "").split("\n")[0] || "{title}");
  const macroDefs = macroEntries.map(([name, value]) => `${name}=${quote(conv.convertText(value))}`);
  const defs = [...macroDefs, ...conv.defs];
  return defs.length ? `${toplevel}\n\n${defs.join("\n")}` : toplevel;
}

type LegacyFields = {
  format?: unknown;
  format_string?: string | null;
  macros?: Record<string, string> | null;
};

/**
 * Upgrade a board record from `format_string` + `macros` to `format`. A
 * record that already has `format` is returned unchanged.
 */
export function upgradeBoardRecord<T extends LegacyFields>(board: T): T {
  if (board.format !== undefined) return board;
  const { format_string, macros, ...rest } = board;
  return { ...rest, format: { version: 2, text: convertLegacyFormat(format_string, macros) } } as unknown as T;
}

/**
 * Convert a legacy list override. It replaced only the board's first line, and
 * a list override inherits the board's definitions, which include the board's
 * converted macros. Generated names get their own prefix so they cannot
 * replace the board's.
 */
function convertLegacyListFormat(formatString: string, boardMacros?: Record<string, string> | null): string {
  const conv = new Converter(new Set(Object.keys(boardMacros ?? {})), "legacy_list_");
  const toplevel = conv.convertText(formatString.split("\n")[0] || "{title}");
  return conv.defs.length ? `${toplevel}\n\n${conv.defs.join("\n")}` : toplevel;
}

/** Upgrade a list record. `boardMacros` are the legacy macros of the list's board. */
export function upgradeListRecord<T extends LegacyFields>(list: T, boardMacros?: Record<string, string> | null): T {
  if (list.format !== undefined) return list;
  const { format_string, macros: _unused, ...rest } = list;
  const format = format_string != null && format_string !== ""
    ? { version: 2, text: convertLegacyListFormat(format_string, boardMacros) }
    : null;
  return { ...rest, format } as unknown as T;
}
