import { describe, it, expect } from "vitest";
import { computeChainHeal } from "./operations.js";
import { ENTITY_SCHEMA_VERSION } from "@listr/shared";

// computeChainHeal is the pure core of the legacy-item heal pass. Detection keys
// on schema_version; conversion re-derives a clean after_id chain in display
// (resolveChain) order and drops the stale `position` field.

describe("computeChainHeal", () => {
  it("converts a pure-legacy list to an after_id chain in position order", () => {
    const items = [
      { id: "b", position: 64, created_at: 1 }, // legacy: no schema_version
      { id: "a", position: 0, created_at: 2 },
      { id: "c", position: 128, created_at: 0 },
    ];
    const out = computeChainHeal(items, 999);
    expect(out.map((u) => [u.id, u.after_id])).toEqual([
      ["a", null],
      ["b", "a"],
      ["c", "b"],
    ]);
    // Every healed record is stamped current, timestamped, and has no position.
    for (const u of out) {
      expect(u.schema_version).toBe(ENTITY_SCHEMA_VERSION);
      expect(u.updated_at).toBe(999);
      expect((u as { position?: number }).position).toBeUndefined();
    }
  });

  it("is a no-op when every item is already current", () => {
    const items = [
      { id: "a", after_id: null, schema_version: ENTITY_SCHEMA_VERSION, created_at: 0 },
      { id: "b", after_id: "a", schema_version: ENTITY_SCHEMA_VERSION, created_at: 1 },
    ];
    expect(computeChainHeal(items, 999)).toEqual([]);
  });

  it("heals a legacy item mixed into a current chain and stamps it", () => {
    const items = [
      { id: "a", after_id: null, schema_version: ENTITY_SCHEMA_VERSION, created_at: 0 },
      { id: "b", after_id: "a", schema_version: ENTITY_SCHEMA_VERSION, created_at: 1 },
      { id: "leg", position: 5, created_at: 2 }, // legacy, no schema_version/after_id
    ];
    const out = computeChainHeal(items, 999);
    const healedLeg = out.find((u) => u.id === "leg");
    expect(healedLeg).toBeDefined();
    expect(healedLeg!.schema_version).toBe(ENTITY_SCHEMA_VERSION);
    expect((healedLeg as { position?: number }).position).toBeUndefined();
    // No returned record keeps a position field, and each has a valid after_id.
    for (const u of out) {
      expect((u as { position?: number }).position).toBeUndefined();
      expect(u.after_id === null || typeof u.after_id === "string").toBe(true);
    }
  });
});
