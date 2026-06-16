import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function parseSimpleYaml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^(\w+):\s*["']?(.+?)["']?\s*$/);
    if (m) result[m[1]] = m[2].trim();
  }
  return result;
}

export function loadConfig(): Record<string, string> {
  try {
    return parseSimpleYaml(readFileSync(join(homedir(), ".config", "listr", "config.yaml"), "utf8"));
  } catch {
    return {};
  }
}

export const config = loadConfig();
