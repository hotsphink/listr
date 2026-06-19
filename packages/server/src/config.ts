import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Config {
  gemini?: string;
  gemini_model?: string;
  tls?: boolean;
  port?: number;
  db_path?: string;
}

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w+):\s*["']?(.+?)["']?\s*$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

export function loadConfig(): Config {
  let raw: Record<string, string> = {};
  try {
    raw = parseSimpleYaml(readFileSync(join(homedir(), ".config", "listr", "config.yaml"), "utf8"));
  } catch {
    // no config file — use defaults
  }
  const config: Config = {};
  if (raw.gemini) config.gemini = raw.gemini;
  if (raw.gemini_model) config.gemini_model = raw.gemini_model;
  if (raw.tls !== undefined) config.tls = raw.tls === "true";
  if (raw.port !== undefined) config.port = parseInt(raw.port, 10);
  if (raw.db_path) config.db_path = raw.db_path;
  return config;
}

export const config = loadConfig();
