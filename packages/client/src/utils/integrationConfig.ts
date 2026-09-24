import { parse as parseToml } from "smol-toml";
import { attributeMaps, type AttributeMaps, type Board } from "@listr/shared";

// Parsed configs by text, so rereading a board's maps doesn't reparse its TOML.
const parsed = new Map<string, unknown>();

function parseCached(text: string): unknown {
  if (!parsed.has(text)) {
    let value: unknown;
    try {
      value = parseToml(text);
    } catch (err) {
      value = err;
    }
    parsed.set(text, value);
  }
  const value = parsed.get(text);
  if (value instanceof Error) throw value;
  return value;
}

/** Which board attribute each integration value fills, per integration. */
export function boardAttributeMaps(board: Pick<Board, "integrations"> | undefined): AttributeMaps {
  return attributeMaps(board?.integrations, parseCached);
}
