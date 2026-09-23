import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileFormat, formatDiagnostic } from "./index.js";
import type { AttributeDefinition, AttributeType } from "../types.js";

// Every multi-line example in doc/FORMAT.md must compile without errors
// against the attributes the examples use.
const doc = readFileSync(fileURLToPath(new URL("../../../../doc/FORMAT.md", import.meta.url)), "utf8");

const types: Record<string, AttributeType> = {
  notes: "text", imdb_id: "text", todo: "todo", rotten: "number", duration: "duration", important: "boolean",
};
const schema: AttributeDefinition[] = Object.entries(types).map(([key, type], position) => ({
  key, label: key, type, required: false, position,
}));

function examples(): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  let inFence = false;
  let prevBlank = true;
  for (const line of doc.split("\n")) {
    if (line.startsWith("```")) inFence = !inFence;
    const blank = line.trim() === "";
    const wasBlank = prevBlank;
    prevBlank = blank;
    if (inFence) continue;
    // An indented code block starts after a blank line; otherwise the
    // indentation continues a list item.
    if ((line.startsWith("    ") && (current || wasBlank)) || (current && blank)) {
      (current ??= []).push(line.slice(4));
    } else if (current) {
      blocks.push(current.join("\n").replace(/\s+$/, ""));
      current = null;
    }
  }
  if (current) blocks.push(current.join("\n").replace(/\s+$/, ""));
  return blocks.filter((b) => b.includes("\n"));
}

describe("doc/FORMAT.md examples", () => {
  const blocks = examples();

  it("finds the examples", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(5);
  });

  for (const [i, block] of blocks.entries()) {
    it(`example ${i + 1} compiles: ${block.split("\n")[0]}`, () => {
      const errors = compileFormat(block, schema).diagnostics
        .filter((d) => d.severity === "error")
        .map(formatDiagnostic);
      expect(errors).toEqual([]);
    });
  }
});
