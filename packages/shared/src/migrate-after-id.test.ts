import { describe, it, expect } from "vitest";
import { migrateListToAfterId, type OrderableItem } from "./migrate-after-id.js";

// Resolve the resulting chain into an ordered id list from the afterIds map.
function orderOf(items: OrderableItem[]): string[] {
  const { afterIds } = migrateListToAfterId(items);
  // Walk from null following the assigned pointers.
  const bySucc = new Map<string | null, string>();
  for (const [id, after] of afterIds) bySucc.set(after, id);
  const order: string[] = [];
  let cur = bySucc.get(null) ?? null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    order.push(cur);
    cur = bySucc.get(cur) ?? null;
  }
  return order;
}

describe("migrateListToAfterId", () => {
  it("orders legacy position-only items by position", () => {
    const items: OrderableItem[] = [
      { id: "b", position: 64 },
      { id: "a", position: 0 },
      { id: "c", position: 128 },
    ];
    const { mixed } = migrateListToAfterId(items);
    expect(orderOf(items)).toEqual(["a", "b", "c"]);
    expect(mixed).toBe(false);
  });

  it("preserves an existing after_id chain", () => {
    const items: OrderableItem[] = [
      { id: "a", after_id: null, created_at: 0 },
      { id: "b", after_id: "a", created_at: 1 },
      { id: "c", after_id: "b", created_at: 2 },
    ];
    const { mixed } = migrateListToAfterId(items);
    expect(orderOf(items)).toEqual(["a", "b", "c"]);
    expect(mixed).toBe(false);
  });

  it("flags internally-mixed lists and puts the after_id chain first", () => {
    const items: OrderableItem[] = [
      { id: "leg1", position: 0 },
      { id: "chain1", after_id: null, created_at: 10 },
      { id: "leg2", position: 64 },
      { id: "chain2", after_id: "chain1", created_at: 11 },
    ];
    const { mixed } = migrateListToAfterId(items);
    expect(mixed).toBe(true);
    // Heuristic: after_id chain (authoritative) then legacy by position.
    expect(orderOf(items)).toEqual(["chain1", "chain2", "leg1", "leg2"]);
  });

  it("breaks forks by created_at", () => {
    const items: OrderableItem[] = [
      { id: "a", after_id: null, created_at: 0 },
      { id: "c", after_id: "a", created_at: 2 },
      { id: "b", after_id: "a", created_at: 1 },
    ];
    // b was created before c, so it comes first after a.
    expect(orderOf(items)).toEqual(["a", "b", "c"]);
  });

  it("appends orphans whose after_id is missing", () => {
    const items: OrderableItem[] = [
      { id: "a", after_id: null, created_at: 0 },
      { id: "orphan", after_id: "gone", created_at: 1 },
    ];
    const order = orderOf(items);
    expect(order).toContain("a");
    expect(order).toContain("orphan");
    expect(order).toHaveLength(2);
  });

  it("assigns a single clean chain (every item reachable from null)", () => {
    const items: OrderableItem[] = [
      { id: "a", position: 0 },
      { id: "b", position: 64 },
      { id: "c", position: 128 },
    ];
    const { afterIds } = migrateListToAfterId(items);
    expect(afterIds.get("a")).toBe(null);
    expect(afterIds.get("b")).toBe("a");
    expect(afterIds.get("c")).toBe("b");
  });
});
