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
 * The winning integration value for each attribute of one item, and the
 * integration each came from. The overlay holds values even for attributes the
 * user has set, since user values are read live and win in effectiveValue.
 * Return null when nothing applies.
 */
export function resolveOverlay(
  item: Item,
  ordered: IntegrationResult[],
  schema: AttributeDefinition[],
): { values: Overlay; sources: Record<string, string> } | null {
  const types = new Map(schema.map((a) => [a.key, a.type]));
  let values: Overlay | null = null;
  const sources: Record<string, string> = {};
  for (const result of ordered) {
    for (const [key, raw] of Object.entries(result.attribute_values)) {
      if (values && key in values) continue;
      // A pick made against a different option set is stale, so its value no longer shows.
      const choice = result.choices?.[key];
      const pick = item.choices?.[key];
      if (choice && pick && pick.options_key !== choice.options_key) continue;
      let value: unknown;
      if (key === "title") value = typeof raw === "string" && raw !== "" ? raw : undefined;
      else {
        const type = types.get(key);
        value = type ? coerceValue(raw, type) : undefined;
      }
      if (value === undefined) continue;
      (values ??= {})[key] = value;
      sources[key] = result.integration_id;
    }
  }
  return values ? { values, sources } : null;
}

/** The overlay values alone. See resolveOverlay. */
export function computeOverlay(item: Item, ordered: IntegrationResult[], schema: AttributeDefinition[]): Overlay | null {
  return resolveOverlay(item, ordered, schema)?.values ?? null;
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
const SETTING_RE = /^\s*#?\s*([A-Za-z0-9_-]+)\s*=/;

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

/** Keys a TOML text mentions, whether set or commented out. */
export function mentionedSettings(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    const m = SETTING_RE.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * Append every template setting the text doesn't mention yet, commented out
 * and with its comment from the template. Leave existing lines alone.
 */
export function addMissingSettings(text: string, template: string): string {
  const present = mentionedSettings(text);
  const blocks = templateEntries(template)
    .filter((e) => !present.has(e.key))
    .map((e) => e.lines.map((l) => (SETTING_RE.test(l) && !l.trim().startsWith("#") ? `# ${l.trim()}` : l)).join("\n"));
  if (!blocks.length) return text;
  const base = text.replace(/\s+$/, "");
  return (base ? base + "\n\n" : "") + blocks.join("\n\n") + "\n";
}
