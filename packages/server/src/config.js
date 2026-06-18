import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
function parseSimpleYaml(content) {
    const result = {};
    for (const line of content.split("\n")) {
        const m = line.match(/^(\w+):\s*["']?(.+?)["']?\s*$/);
        if (m)
            result[m[1]] = m[2].trim();
    }
    return result;
}
export function loadConfig() {
    try {
        return parseSimpleYaml(readFileSync(join(homedir(), ".config", "listr", "config.yaml"), "utf8"));
    }
    catch {
        return {};
    }
}
export const config = loadConfig();
