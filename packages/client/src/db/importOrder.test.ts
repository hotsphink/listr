import { describe, it, expect } from "vitest";
import { computeAiImportOrder } from "./exportImport.js";

describe("computeAiImportOrder", () => {
  function posMap(updates: { id: string; position: number }[]) {
    return new Map(updates.map((u) => [u.id, u.position]));
  }

  it("moves an existing item forward past non-imported items", () => {
    // Mirrors the real bug: Edward(0), Panique(1), JustGoWithIt(2), Ford(3)
    // Import says: Edward, JustGoWithIt
    // Expected: Edward(0), JustGoWithIt(1), Panique(2), Ford(3)
    const items = [
      { id: "edward", position: 0 },
      { id: "panique", position: 1 },
      { id: "just-go", position: 2 },
      { id: "ford", position: 3 },
    ];
    const updates = computeAiImportOrder(["edward", "just-go"], items);
    const pos = posMap(updates);
    expect(pos.has("edward")).toBe(false);  // already at 0, no change
    expect(pos.get("just-go")).toBe(1);
    expect(pos.get("panique")).toBe(2);
    expect(pos.has("ford")).toBe(false);    // already at 3, no change
  });

  it("moves an existing item backward", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
      { id: "c", position: 2 },
    ];
    // Import says: c, a — b is not imported
    // Expected: c(0), a(1), b(2)
    const pos = posMap(computeAiImportOrder(["c", "a"], items));
    expect(pos.get("c")).toBe(0);
    expect(pos.get("a")).toBe(1);
    expect(pos.get("b")).toBe(2);
  });

  it("returns no updates when order already matches", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
      { id: "c", position: 2 },
    ];
    const updates = computeAiImportOrder(["a", "b"], items);
    expect(updates).toHaveLength(0);
  });

  it("non-imported items preserve their relative order", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
      { id: "c", position: 2 },
      { id: "d", position: 3 },
      { id: "e", position: 4 },
    ];
    // Only import c — a, b, d, e are non-imported and should stay in relative order
    const pos = posMap(computeAiImportOrder(["c"], items));
    expect(pos.get("c")).toBe(0);
    expect(pos.get("a")).toBe(1);
    expect(pos.get("b")).toBe(2);
    // d and e land at 3 and 4 — same as before, so no update needed
    expect(pos.has("d")).toBe(false);
    expect(pos.has("e")).toBe(false);
  });

  it("handles empty import — nothing changes", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ];
    expect(computeAiImportOrder([], items)).toHaveLength(0);
  });

  it("ignores imported IDs not present in the list", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
    ];
    // "ghost" doesn't exist in the list yet (created after this call)
    const updates = computeAiImportOrder(["a", "ghost", "b"], items);
    expect(updates).toHaveLength(0); // a→0, b→1, no change
  });

  it("all items imported — full reorder", () => {
    const items = [
      { id: "a", position: 0 },
      { id: "b", position: 1 },
      { id: "c", position: 2 },
    ];
    const pos = posMap(computeAiImportOrder(["c", "a", "b"], items));
    expect(pos.get("c")).toBe(0);
    expect(pos.get("a")).toBe(1);
    expect(pos.get("b")).toBe(2);
  });
});
