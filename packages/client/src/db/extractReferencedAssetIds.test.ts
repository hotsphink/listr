import { describe, it, expect } from "vitest";
import { extractReferencedAssetIds } from "./exportImport.js";

const ID_A = "0123456789abcdef0123";
const ID_B = "abcdef0123456789abcd";

const fmt = (text: string) => ({ version: 2, text });

describe("extractReferencedAssetIds", () => {
  it("finds a reference in the board's format", () => {
    const ids = extractReferencedAssetIds(
      { format: fmt(`[title] ![img](hash://${ID_A}.png)`) },
      [],
      [],
    );
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("finds references in board definitions", () => {
    const ids = extractReferencedAssetIds(
      { format: fmt(`[title]\n\nimg1="![name](hash://${ID_A}.png)"`) },
      [],
      [],
    );
    expect(ids).toEqual(new Set([ID_A]));
  });

  it("finds references in list formats", () => {
    const ids = extractReferencedAssetIds(
      {},
      [{ format: fmt(`hash://${ID_B}.jpg`) }],
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
      { format: fmt(`hash://${ID_A}.png\n\nm="hash://${ID_A}.png"`) },
      [{ format: fmt(`hash://${ID_B}.jpg`) }],
      [{ attributes: { photo: `hash://${ID_B}.jpg` } }],
    );
    expect(ids).toEqual(new Set([ID_A, ID_B]));
  });

  it("returns an empty set when nothing references an asset", () => {
    const ids = extractReferencedAssetIds({ format: fmt("[title]") }, [{ format: null }], [{ attributes: {} }]);
    expect(ids.size).toBe(0);
  });
});
