import { describe, it, expect } from "vitest";
import { ENTITY_SCHEMA_VERSION, isCurrentSchemaVersion } from "./schema-version.js";

describe("isCurrentSchemaVersion", () => {
  it("accepts the current version", () => {
    expect(isCurrentSchemaVersion(ENTITY_SCHEMA_VERSION)).toBe(true);
  });

  it("accepts a newer version", () => {
    expect(isCurrentSchemaVersion(ENTITY_SCHEMA_VERSION + 1)).toBe(true);
  });

  it("rejects an older version", () => {
    expect(isCurrentSchemaVersion(ENTITY_SCHEMA_VERSION - 1)).toBe(false);
  });

  it("rejects missing / non-numeric versions (pre-versioning = legacy)", () => {
    expect(isCurrentSchemaVersion(undefined)).toBe(false);
    expect(isCurrentSchemaVersion(null)).toBe(false);
    expect(isCurrentSchemaVersion("2")).toBe(false);
  });
});
