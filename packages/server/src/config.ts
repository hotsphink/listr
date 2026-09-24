import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse } from "yaml";
import { DEFAULT_MODEL_URL, type ModelConfig } from "./gemini.js";

export type { ModelConfig };

export interface IntegrationServerConfig {
  api_key?: string;
  /** Runs of this module at once. */
  max_concurrent?: number;
  /** Per-request timeout for external calls. */
  timeout_ms?: number;
  /** External calls per UTC day, across all sync keys. Missing = no limit. */
  daily_limit?: number;
  /** External calls per UTC day for any one sync key. Missing = no limit. */
  daily_limit_per_key?: number;
  /** Additional integration-specific settings. */
  [key: string]: unknown;
}

const NUMERIC_INTEGRATION_SETTINGS = ["max_concurrent", "timeout_ms", "daily_limit", "daily_limit_per_key"] as const;

export interface Config {
  /** Vision models to try, tried one tier at a time. A tier's models run in
   * parallel and the first usable answer wins. Empty means screenshot import
   * is off. */
  tiers: ModelConfig[][];
  tls?: boolean;
  port?: number;
  db_path?: string;
  variant: string;
  /** Let the first client to authenticate against a database with no users at
   * all claim it as the root user. Off unless asked for: on a reachable
   * server it hands root to whoever connects first. See index.ts. */
  allow_bootstrap?: boolean;
  integrations?: Record<string, IntegrationServerConfig>;
}

// Accept both the native YAML type and its quoted string spelling, since the
// config file is hand-edited and `port: 10000` and `port: "10000"` both read
// as the same intent.
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// Flattens one YAML mapping to string fields. Scalars stringify so a numeric
// or boolean setting can still be interpolated into a url template. Nested
// mappings and lists drop out, which is what keeps a family's own `models`
// list from leaking into the fields its models inherit.
function asFields(value: unknown): Record<string, string> | undefined {
  const object = asObject(value);
  if (!object) return undefined;
  const fields: Record<string, string> = {};
  for (const [key, raw] of Object.entries(object)) {
    if (typeof raw === "string") fields[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") fields[key] = String(raw);
  }
  return fields;
}

interface ModelOverrides {
  model: string;
  overrides: Record<string, string>;
}

// A family's `models` maps each model name to its overrides, spelled either as
// a mapping or as a list of one-key mappings.
function parseFamilyModels(value: unknown): ModelOverrides[] {
  const models: ModelOverrides[] = [];

  const mapping = asObject(value);
  if (mapping) {
    for (const [model, overrides] of Object.entries(mapping)) {
      models.push({ model, overrides: asFields(overrides) ?? {} });
    }
    return models;
  }
  if (!Array.isArray(value)) return models;

  for (const item of value) {
    if (typeof item === "string") {
      models.push({ model: item, overrides: {} });
      continue;
    }
    const entry = asObject(item);
    if (!entry) continue;
    const pairs = Object.entries(entry);
    if (pairs.length !== 1) {
      const keys = pairs.map(([key]) => key).join(", ");
      console.error(`[config] ignoring models entry [${keys}]: one entry names one model, and its overrides belong under it`);
      continue;
    }
    const [model, overrides] = pairs[0];
    models.push({ model, overrides: asFields(overrides) ?? {} });
  }
  return models;
}

// Every model a family declares, resolved against the family's own settings.
// Model keys override the family's.
function parseRegistry(value: unknown): Map<string, ModelConfig> {
  const registry = new Map<string, ModelConfig>();
  if (!Array.isArray(value)) return registry;

  for (const entry of value) {
    const family = asFields(entry);
    const object = asObject(entry);
    if (!family || !object) continue;
    if (!family.name) {
      console.error("[config] ignoring model_families entry with no name");
      continue;
    }
    for (const { model, overrides } of parseFamilyModels(object.models)) {
      if (registry.has(model)) {
        console.error(`[config] model '${model}' declared more than once, keeping the first`);
        continue;
      }
      const fields: Record<string, string> = { ...family, ...overrides, model };
      registry.set(model, { model, url: fields.url ?? DEFAULT_MODEL_URL, fields });
    }
  }
  return registry;
}

// Tiers are tried in order. Models within a tier run in parallel, so a tier is
// a list of names drawn from the families above.
function parseTiers(value: unknown, registry: Map<string, ModelConfig>): ModelConfig[][] {
  if (!Array.isArray(value)) return [];
  const tiers: ModelConfig[][] = [];
  for (const raw of value) {
    const names = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
    const tier: ModelConfig[] = [];
    for (const name of names) {
      if (typeof name !== "string") continue;
      const entry = registry.get(name);
      if (!entry) {
        console.error(`[config] tier references unknown model '${name}'`);
        continue;
      }
      tier.push(entry);
    }
    if (tier.length > 0) tiers.push(tier);
  }
  return tiers;
}

// Keys under `services` that configure models rather than an integration.
const MODEL_SECTIONS = new Set(["model_families", "vision"]);

// Per-integration server settings, keyed by integration id. Each lives under
// `services`, and the older top-level `integrations` mapping still works,
// with `services` winning where both name the same id.
function parseIntegrations(
  legacy: unknown,
  services: unknown,
): Record<string, IntegrationServerConfig> | undefined {
  const sources: Array<[string, unknown]> = Object.entries(asObject(legacy) ?? {});
  for (const [id, cfg] of Object.entries(asObject(services) ?? {})) {
    if (MODEL_SECTIONS.has(id)) continue;
    sources.push([id, cfg]);
  }
  if (sources.length === 0) return undefined;

  const integrations: Record<string, IntegrationServerConfig> = {};
  for (const [id, cfg] of sources) {
    const entry = asObject(cfg);
    if (!entry) continue;
    const merged: IntegrationServerConfig = { ...integrations[id], ...entry };
    for (const key of NUMERIC_INTEGRATION_SETTINGS) {
      const n = asNumber(entry[key]);
      if (n !== undefined) merged[key] = n;
      else if (key in entry) merged[key] = integrations[id]?.[key];
    }
    integrations[id] = merged;
  }
  return integrations;
}

function parseServices(value: unknown): ModelConfig[][] {
  const services = asObject(value);
  if (!services) return [];
  const registry = parseRegistry(services.model_families);
  return parseTiers(asObject(services.vision)?.tiers, registry);
}

export function loadConfig(): Config {
  let raw: Record<string, unknown> = {};
  // Which world this server belongs to (dev, prod, or another). Picks the
  // config file below, and the caller advertises it to clients in the
  // `challenge` handshake message, so a client built for one variant can
  // refuse to sync with a server running another.
  const variant = process.env.LISTR_VARIANT ?? "prod";
  const path = process.env.LISTR_CONFIG_PATH ?? join(homedir(), ".config", "listr", variant + ".yaml");
  try {
    const parsed: unknown = parse(readFileSync(path, "utf8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    // A missing file is normal, so fall back to defaults. Anything else means
    // the file exists but does not parse, and starting with default settings
    // would hide the typo, so say so loudly.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.error(`[config] failed to read ${path}, using defaults:`, err instanceof Error ? err.message : err);
    }
  }
  const config: Config = { variant, tiers: [] };
  config.tls = asBool(raw.tls);
  config.port = asNumber(raw.port);
  config.db_path = asString(raw.db_path);
  config.allow_bootstrap = asBool(raw.allow_bootstrap);
  config.tiers = parseServices(raw.services);
  // Env override, so provisioning a new server is one restart rather than a
  // config edit and a revert.
  if (process.env.LISTR_ALLOW_BOOTSTRAP !== undefined) {
    config.allow_bootstrap = process.env.LISTR_ALLOW_BOOTSTRAP !== "" && process.env.LISTR_ALLOW_BOOTSTRAP !== "0";
  }
  config.integrations = parseIntegrations(raw.integrations, raw.services);
  return config;
}

export const config = loadConfig();
