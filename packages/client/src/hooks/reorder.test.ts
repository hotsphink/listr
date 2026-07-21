import { describe, it, expect } from "vitest";
import { reorderByAfterId, resolveChain } from "./reorderLogic.js";

// Build a chain from an ordered list of ids.
function chain(ids: string[]): { id: string; after_id: string | null }[] {
  return ids.map((id, i) => ({ id, after_id: i === 0 ? null : ids[i - 1] }));
}

// Apply updates to a chain and return the new chain order.
function applyAndOrder(items: { id: string; after_id: string | null }[], updates: { id: string; after_id: string | null }[]): string[] {
  const m = new Map(updates.map((u) => [u.id, u.after_id]));
  const updated = items.map((i) => ({ ...i, after_id: m.has(i.id) ? m.get(i.id)! : i.after_id }));
  return resolveChain(updated as any).map((i) => i.id);
}

describe("reorderByAfterId", () => {
  it("moves a middle item to the end", () => {
    const items = chain(["a", "b", "c", "d"]);
    // Move b to after d
    const result = applyAndOrder(items, reorderByAfterId(items, "b", "d"));
    expect(result).toEqual(["a", "c", "d", "b"]);
  });

  it("moves the last item to the beginning", () => {
    const items = chain(["a", "b", "c"]);
    // Move c to after null (first)
    const result = applyAndOrder(items, reorderByAfterId(items, "c", null));
    expect(result).toEqual(["c", "a", "b"]);
  });

  it("moves first item to the end", () => {
    const items = chain(["a", "b", "c"]);
    const result = applyAndOrder(items, reorderByAfterId(items, "a", "c"));
    expect(result).toEqual(["b", "c", "a"]);
  });

  it("moves item one position forward", () => {
    const items = chain(["a", "b", "c"]);
    // Move a to after b
    const result = applyAndOrder(items, reorderByAfterId(items, "a", "b"));
    expect(result).toEqual(["b", "a", "c"]);
  });

  it("moves item one position backward", () => {
    const items = chain(["a", "b", "c"]);
    // Move c to after a
    const result = applyAndOrder(items, reorderByAfterId(items, "c", "a"));
    expect(result).toEqual(["a", "c", "b"]);
  });

  it("returns empty array for no-op (already in position)", () => {
    const items = chain(["a", "b", "c"]);
    // b already follows a
    expect(reorderByAfterId(items, "b", "a")).toEqual([]);
  });

  it("two-item list: move first to end", () => {
    const items = chain(["x", "y"]);
    const result = applyAndOrder(items, reorderByAfterId(items, "x", "y"));
    expect(result).toEqual(["y", "x"]);
  });

  it("two-item list: move last to beginning", () => {
    const items = chain(["x", "y"]);
    const result = applyAndOrder(items, reorderByAfterId(items, "y", null));
    expect(result).toEqual(["y", "x"]);
  });

  it("does not mutate the original array", () => {
    const items = chain(["a", "b", "c"]);
    reorderByAfterId(items, "a", "c");
    expect(items[0]).toEqual({ id: "a", after_id: null });
  });
});

describe("resolveChain", () => {
  it("resolves a simple chain", () => {
    const items = chain(["a", "b", "c"]);
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("handles forks by created_at tiebreak", () => {
    // Both b and c say they follow a
    const items = [
      { id: "a", after_id: null, created_at: 0, list_id: "", title: "", updated_at: 0, attributes: {} },
      { id: "b", after_id: "a", created_at: 1, list_id: "", title: "", updated_at: 0, attributes: {} },
      { id: "c", after_id: "a", created_at: 2, list_id: "", title: "", updated_at: 0, attributes: {} },
    ];
    const order = resolveChain(items).map((i) => i.id);
    expect(order[0]).toBe("a");
    expect(new Set(order)).toEqual(new Set(["a", "b", "c"]));
  });

  it("appends orphaned items at end", () => {
    const items = [
      { id: "a", after_id: null, created_at: 0, list_id: "", title: "", updated_at: 0, attributes: {} },
      { id: "b", after_id: "missing", created_at: 1, list_id: "", title: "", updated_at: 0, attributes: {} },
    ];
    const order = resolveChain(items).map((i) => i.id);
    expect(order).toContain("a");
    expect(order).toContain("b");
    expect(order).toHaveLength(2);
  });

  // Regression: legacy items pulled from a not-yet-migrated server carry only
  // `position` (no after_id). They must order by position, not creation order.
  it("orders legacy position-only items by position, not created_at", () => {
    const items = [
      { id: "c", position: 128, created_at: 1 }, // created first, but position last
      { id: "a", position: 0, created_at: 3 },
      { id: "b", position: 64, created_at: 2 },
    ];
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("splices an after_id item into a legacy position list at its predecessor", () => {
    // Legacy list a(0), b(64), c(128); a new item n was dropped after b.
    const items = [
      { id: "a", position: 0, created_at: 0 },
      { id: "b", position: 64, created_at: 1 },
      { id: "c", position: 128, created_at: 2 },
      { id: "n", after_id: "b", created_at: 9 },
    ];
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["a", "b", "n", "c"]);
  });
});
