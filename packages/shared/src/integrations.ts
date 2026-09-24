// Integration values are never stored on the item. They live on
// IntegrationResult rows and are laid over the item's user-set values when
// read. This module holds the shared overlay rules, type coercion, and TOML
// config-template helpers.

import type { AttributeDefinition, AttributeType, Integration, IntegrationResult, Item } from "./types.js";
import { isSet, parseDurationText } from "./format/values.js";

/** Integration values for one item, after priority, choice and schema rules. */
export type Overlay = Record<string, unknown>;

// -- Coercion ------------------------------------------------------------------

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const text = v.trim().replace(/,/g, "");
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) return undefined;
  return Number(text);
}

/**
 * Convert a value to an attribute type. Return undefined when it can't be
 * converted, so callers drop it.
 */
export function coerceValue(v: unknown, type: AttributeType): unknown {
  if (v === undefined || v === null) return undefined;
  switch (type) {
    case "text":
    case "url":
    case "enum":
      if (Array.isArray(v)) return v.map(String).join(", ");
      return typeof v === "object" ? undefined : String(v);
    case "number":
      return toNumber(v);
    case "integer": {
      const n = toNumber(v);
      return n !== undefined && Number.isInteger(n) ? n : undefined;
    }
    case "duration": {
      const n = toNumber(v);
      if (n !== undefined) return n;
      return typeof v === "string" ? parseDurationText(v) ?? undefined : undefined;
    }
    case "boolean":
      if (typeof v === "boolean") return v;
      if (v === "true") return true;
      if (v === "false") return false;
      return undefined;
    case "date":
    case "datetime": {
      if (typeof v !== "string" && typeof v !== "number") return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) return undefined;
      return type === "date" ? d.toISOString().slice(0, 10) : d.toISOString().slice(0, 16);
    }
    case "tags": {
      const parts = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
      const tags = parts.map((t) => t.trim()).filter((t) => t !== "");
      return tags.length ? tags : undefined;
    }
    case "todo":
      return undefined;
  }
}

// -- Overlay ---------------------------------------------------------------------

/** Results in priority order: the board's enabled integrations, first listed wins. */
export function orderResults(results: IntegrationResult[], integrations: Integration[] | undefined): IntegrationResult[] {
  const rank = new Map<string, number>();
  (integrations ?? []).forEach((cfg, i) => {
    if (cfg.enabled && !rank.has(cfg.integration_id)) rank.set(cfg.integration_id, i);
  });
  return results
    .filter((r) => rank.has(r.integration_id))
    .sort((a, b) => rank.get(a.integration_id)! - rank.get(b.integration_id)!);
}

/**
 * Per integration, which board attribute each of its values fills, from the
 * `attributes` table of its TOML config. A value mapped to "" is left out, and
 * an unmapped value fills the attribute with its own key.
 */
export type AttributeMaps = Record<string, Record<string, string>>;

/**
 * Read each integration's attribute map from its config. `parse` is the
 * caller's TOML parser. A config that doesn't parse maps nothing.
 */
export function attributeMaps(integrations: Integration[] | undefined, parse: (text: string) => unknown): AttributeMaps {
  const maps: AttributeMaps = {};
  for (const cfg of integrations ?? []) {
    if (!cfg.config) continue;
    let table: unknown;
    try {
      table = (parse(cfg.config) as Record<string, unknown>)?.attributes;
    } catch {
      continue;
    }
    if (!table || typeof table !== "object") continue;
    const map: Record<string, string> = {};
    for (const [key, target] of Object.entries(table as Record<string, unknown>)) {
      if (typeof target === "string") map[key] = target;
    }
    maps[cfg.integration_id] = map;
  }
  return maps;
}

/** An integration value the overlay couldn't show, and why. */
export interface UnshownValue {
  integration_id: string;
  /** The integration's own key for the value. */
  key: string;
  /** The board attribute it maps to. */
  target: string;
  value: unknown;
  /** No board attribute has the target key, or the value doesn't convert to that attribute's type. */
  reason: "no_attribute" | "wrong_type";
  /** The target attribute's type, for wrong_type. */
  type?: AttributeType;
}

export interface ResolvedOverlay {
  values: Overlay;
  /** The integration each value came from, by board attribute key. */
  sources: Record<string, string>;
  unshown: UnshownValue[];
}

/**
 * The winning integration value for each board attribute of one item, the
 * integration each came from, and the values that couldn't be shown. The
 * overlay holds values even for attributes the user has set, since user values
 * are read live and win in effectiveValue. Return null when nothing applies.
 */
export function resolveOverlay(
  item: Item,
  ordered: IntegrationResult[],
  schema: AttributeDefinition[],
  maps: AttributeMaps = {},
): ResolvedOverlay | null {
  const types = new Map(schema.map((a) => [a.key, a.type]));
  const values: Overlay = {};
  const sources: Record<string, string> = {};
  const unshown: UnshownValue[] = [];
  for (const result of ordered) {
    const map = maps[result.integration_id] ?? {};
    for (const [key, raw] of Object.entries(result.attribute_values)) {
      const target = map[key] ?? key;
      if (target === "" || target in values) continue;
      // A pick made against a different option set is stale, so its value no longer shows.
      const choice = result.choices?.[key];
      const pick = item.choices?.[key];
      if (choice && pick && pick.options_key !== choice.options_key) continue;
      let value: unknown;
      if (target === "title") {
        value = typeof raw === "string" && raw !== "" ? raw : undefined;
      } else {
        const type = types.get(target);
        if (!type) {
          unshown.push({ integration_id: result.integration_id, key, target, value: raw, reason: "no_attribute" });
          continue;
        }
        value = coerceValue(raw, type);
        if (value === undefined) {
          unshown.push({ integration_id: result.integration_id, key, target, value: raw, reason: "wrong_type", type });
          continue;
        }
      }
      if (value === undefined) continue;
      values[target] = value;
      sources[target] = result.integration_id;
    }
  }
  // A value shadowed by a higher-priority integration's isn't missing, just outranked.
  const stillUnshown = unshown.filter((u) => !(u.target in values));
  return Object.keys(values).length || stillUnshown.length ? { values, sources, unshown: stillUnshown } : null;
}

/** The overlay values alone, or null when there are none. See resolveOverlay. */
export function computeOverlay(item: Item, ordered: IntegrationResult[], schema: AttributeDefinition[], maps: AttributeMaps = {}): Overlay | null {
  const values = resolveOverlay(item, ordered, schema, maps)?.values;
  return values && Object.keys(values).length ? values : null;
}

/**
 * Commented-out `attributes.<key>` lines for every value a module produces, to
 * append to its config template.
 */
export function attributeMapTemplate(keys: string[]): string {
  if (!keys.length) return "";
  return [
    "# Board attribute each value fills, when the board's key differs. \"\" leaves the value out.",
    ...keys.map((k) => `# attributes.${k} = "${k}"`),
    "",
  ].join("\n");
}

/** What a reader sees for one attribute: the user's value if set, else the overlay's. */
export function effectiveValue(item: Item, key: string, overlay: Overlay | null | undefined): unknown {
  const own = key === "title" ? item.title : item.attributes[key];
  if (isSet(own) || !overlay || !(key in overlay)) return own;
  return overlay[key];
}

/** The item as readers see it. Return the item itself when there is no overlay. */
export function withOverlay(item: Item, overlay: Overlay | null | undefined): Item {
  if (!overlay) return item;
  const attributes = { ...item.attributes };
  for (const [key, value] of Object.entries(overlay)) {
    if (key !== "title" && !isSet(attributes[key])) attributes[key] = value;
  }
  const title = isSet(item.title) ? item.title : (overlay.title as string | undefined) ?? item.title;
  return { ...item, title, attributes };
}

/** Every attribute value a search should match, overlay included. */
export function effectiveValues(item: Item, overlay: Overlay | null | undefined): unknown[] {
  const merged = withOverlay(item, overlay);
  return [merged.title, ...Object.values(merged.attributes)];
}

// -- Choices ---------------------------------------------------------------------

/** A stable hash of a list of option values (FNV-1a, 32 bit, hex). */
export function optionsKey(values: string[]): string {
  let h = 0x811c9dc5;
  const text = JSON.stringify(values);
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * The item edit a pick makes: record the pick, and clear each released user
 * attribute while keeping its value as the lookup's query.
 */
export function applyPick(
  item: Item,
  attr: string,
  choice: { options_key: string; releases?: string[] },
  value: string,
): Pick<Item, "title" | "attributes" | "choices"> {
  const query: Record<string, unknown> = { ...(item.choices?.[attr]?.query ?? {}) };
  let title = item.title;
  const attributes = { ...item.attributes };
  for (const key of choice.releases ?? []) {
    if (key === "title") {
      if (isSet(title)) query.title = title;
      title = "";
    } else {
      if (isSet(attributes[key])) query[key] = attributes[key];
      delete attributes[key];
    }
  }
  const pick = { value, options_key: choice.options_key, ...(Object.keys(query).length ? { query } : {}) };
  return { title, attributes, choices: { ...(item.choices ?? {}), [attr]: pick } };
}

// -- TOML config templates -------------------------------------------------------

// A setting line, set or commented out: `key = value` or `# key = value`.
// Keys may be dotted, like `attributes.year`.
const SETTING_RE = /^\s*#?\s*([A-Za-z0-9_.-]+)\s*=/;
// An uncommented table header, such as `[attributes]`.
const TABLE_RE = /^\s*\[([A-Za-z0-9_.-]+)\]\s*(#.*)?$/;

interface TemplateEntry {
  key: string;
  /** The setting's own comment lines followed by its (commented) setting line. */
  lines: string[];
}

function templateEntries(template: string): TemplateEntry[] {
  const entries: TemplateEntry[] = [];
  let pending: string[] = [];
  for (const line of template.split("\n")) {
    const m = SETTING_RE.exec(line);
    if (m) {
      entries.push({ key: m[1], lines: [...pending, line] });
      pending = [];
    } else if (line.trim().startsWith("#")) {
      pending.push(line);
    } else {
      pending = [];
    }
  }
  return entries;
}

/**
 * Keys a TOML text mentions, whether set or commented out, as full dotted
 * paths: `year = 1` under `[attributes]` is `attributes.year`.
 */
export function mentionedSettings(text: string): Set<string> {
  const keys = new Set<string>();
  let table = "";
  for (const line of text.split("\n")) {
    const header = TABLE_RE.exec(line);
    if (header) {
      table = header[1] + ".";
      continue;
    }
    const m = SETTING_RE.exec(line);
    if (m) keys.add(table + m[1]);
  }
  return keys;
}

/**
 * Add every template setting the text doesn't mention yet, commented out and
 * with its comment from the template. Leave existing lines alone. The new
 * lines go before the first table header, if any, so they stay top-level keys.
 */
export function addMissingSettings(text: string, template: string): string {
  const present = mentionedSettings(text);
  const blocks = templateEntries(template)
    .filter((e) => !present.has(e.key))
    .map((e) => e.lines.map((l) => (SETTING_RE.test(l) && !l.trim().startsWith("#") ? `# ${l.trim()}` : l)).join("\n"));
  if (!blocks.length) return text;
  const added = blocks.join("\n\n");
  const lines = text.split("\n");
  const firstTable = lines.findIndex((l) => TABLE_RE.test(l));
  if (firstTable >= 0) {
    const before = lines.slice(0, firstTable).join("\n").replace(/\s+$/, "");
    return (before ? before + "\n\n" : "") + added + "\n\n" + lines.slice(firstTable).join("\n");
  }
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + added + "\n";
}
