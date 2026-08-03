import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface IntegrationServerConfig {
  api_key?: string;
  refresh_interval?: number; // seconds; 0 or missing = no periodic refresh
  [key: string]: unknown;    // additional integration-specific config
}

export interface Config {
  gemini?: string;
  gemini_model?: string;
  tls?: boolean;
  port?: number;
  db_path?: string;
  integrations?: Record<string, IntegrationServerConfig>;
}

// Parses a simple YAML file with up to 3 levels of indentation (0, 2, 4 spaces).
// Does not handle arrays, multi-line values, or anchors.
function parseSimpleYaml(content: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let section: string | null = null;
  let subsection: string | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.match(/^( *)/)?.[1].length ?? 0;
    const trimmed = line.trim();
    const m = trimmed.match(/^([\w-]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const val = rawVal.replace(/^["']|["']$/g, "");

    if (indent === 0) {
      if (val) {
        result[key] = val;
        section = null;
        subsection = null;
      } else {
        section = key;
        subsection = null;
        if (typeof result[key] !== "object" || result[key] === null) result[key] = {};
      }
    } else if (indent === 2 && section) {
      const sec = result[section] as Record<string, unknown>;
      if (val) {
        sec[key] = val;
        subsection = null;
      } else {
        subsection = key;
        if (typeof sec[key] !== "object" || sec[key] === null) sec[key] = {};
      }
    } else if (indent === 4 && section && subsection) {
      const sub = (result[section] as Record<string, Record<string, string>>)[subsection];
      if (typeof sub === "object" && sub !== null) sub[key] = val;
    }
  }

  return result;
}

export function loadConfig(): Config {
  let raw: Record<string, unknown> = {};
  try {
    raw = parseSimpleYaml(readFileSync(join(homedir(), ".config", "listr", "config.yaml"), "utf8"));
  } catch {
    // no config file — use defaults
  }
  const config: Config = {};
  if (typeof raw.gemini === "string") config.gemini = raw.gemini;
  if (typeof raw.gemini_model === "string") config.gemini_model = raw.gemini_model;
  if (typeof raw.tls === "string") config.tls = raw.tls === "true";
  if (typeof raw.port === "string") config.port = parseInt(raw.port, 10);
  if (typeof raw.db_path === "string") config.db_path = raw.db_path;
  if (typeof raw.integrations === "object" && raw.integrations !== null) {
    const integrations: Record<string, IntegrationServerConfig> = {};
    for (const [id, cfg] of Object.entries(raw.integrations as Record<string, Record<string, string>>)) {
      if (typeof cfg !== "object" || cfg === null) continue;
      integrations[id] = {
        ...cfg,
        refresh_interval: typeof cfg.refresh_interval === "string" ? parseInt(cfg.refresh_interval, 10) : undefined,
      };
    }
    config.integrations = integrations;
  }
  return config;
}

export const config = loadConfig();
