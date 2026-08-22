import { describe, it, expect } from "vitest";
import { extractReferencedAssetIds } from "./exportImport.js";

const ID_A = "0123456789abcdef0123";
const ID_B = "abcdef0123456789abcd";

describe("extractReferencedAssetIds", () => {
  it("finds a reference in the board's format_string", () => {
    const ids = extractReferencedAssetIds(
      { format_string: `{title} ![img](hash://${ID_A}.png)` },
      [],
      [],
    );
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("finds references in board macros", () => {
    const ids = extractReferencedAssetIds(
      { macros: { img1: `![name](hash://${ID_A}.png)` } },
      [],
      [],
    );
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("finds references in list format strings", () => {
    const ids = extractReferencedAssetIds(
      {},
      [{ format_string: `hash://${ID_B}.jpg` }],
      [],
    );
    expect(ids).toEqual(new Set([ID_B]));
  });

  it("finds references in string-valued item attributes", () => {
    const ids = extractReferencedAssetIds(
      {},
      [],
      [{ attributes: { photo: `hash://${ID_A}.png`, note: "plain text" } }],
    );
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("ignores non-string attribute values", () => {
    const ids = extractReferencedAssetIds(
      {},
      [],
      [{ attributes: { count: 5, done: true, tags: ["a", "b"] } }],
    );
    expect(ids.size).toBe(0);
  });

  it("dedupes and collects across multiple sources", () => {
    const ids = extractReferencedAssetIds(
      { format_string: `hash://${ID_A}.png`, macros: { m: `hash://${ID_A}.png` } },
      [{ format_string: `hash://${ID_B}.jpg` }],
      [{ attributes: { photo: `hash://${ID_B}.jpg` } }],
    );
    expect(ids).toEqual(new Set([ID_A, ID_B]));
  });

  it("returns an empty set when nothing references an asset", () => {
    const ids = extractReferencedAssetIds({ format_string: "{title}" }, [{ format_string: null }], [{ attributes: {} }]);
    expect(ids.size).toBe(0);
  });
});
