import { describe, it, expect } from "vitest";
import { computeAiImportOrder } from "./exportImport.js";
import { resolveChain } from "./operations.js";

// Helper: build a simple chain from an ordered array of ids.
// Each item's after_id points to the previous item (null for first).
function makeChain(ids: string[]): { id: string; after_id: string | null; list_id: string; title: string; created_at: number; updated_at: number; attributes: Record<string, unknown> }[] {
  return ids.map((id, i) => ({
    id,
    after_id: i === 0 ? null : ids[i - 1],
    list_id: "L1",
    title: id,
    created_at: i,
    updated_at: i,
    attributes: {},
  }));
}

// Helper: extract the resulting chain order from the updates applied to the original chain.
function applyAndResolve(items: { id: string; after_id: string | null; list_id: string; title: string; created_at: number; updated_at: number; attributes: Record<string, unknown> }[], updates: { id: string; after_id: string | null }[]): string[] {
  const updateMap = new Map(updates.map((u) => [u.id, u.after_id]));
  const updated = items.map((i) => ({
    ...i,
    after_id: updateMap.has(i.id) ? updateMap.get(i.id)! : i.after_id,
  }));
  return resolveChain(updated).map((i) => i.id);
}

describe("computeAiImportOrder", () => {
  it("moves an existing item forward past non-imported items", () => {
    // Chain: edward → panique → just-go → ford
    // Import says: edward, just-go
    // Expected final order: edward, just-go, panique, ford
    const items = makeChain(["edward", "panique", "just-go", "ford"]);
    const updates = computeAiImportOrder(["edward", "just-go"], items);
    const order = applyAndResolve(items, updates);
    expect(order).toEqual(["edward", "just-go", "panique", "ford"]);
  });

  it("moves an existing item backward", () => {
    // Chain: a → b → c  |  Import: c, a  |  Expected: c, a, b
    const items = makeChain(["a", "b", "c"]);
    const order = applyAndResolve(items, computeAiImportOrder(["c", "a"], items));
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("returns no updates when order already matches", () => {
    const items = makeChain(["a", "b", "c"]);
    expect(computeAiImportOrder(["a", "b"], items)).toHaveLength(0);
  });

  it("non-imported items preserve their relative order", () => {
    // Chain: a → b → c → d → e  |  Import: c  |  Expected: c, a, b, d, e
    const items = makeChain(["a", "b", "c", "d", "e"]);
    const order = applyAndResolve(items, computeAiImportOrder(["c"], items));
    expect(order).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("handles empty import — nothing changes", () => {
    const items = makeChain(["a", "b"]);
    expect(computeAiImportOrder([], items)).toHaveLength(0);
  });

  it("ignores imported IDs not present in the list", () => {
    const items = makeChain(["a", "b"]);
    // "ghost" doesn't exist — should be a no-op
    expect(computeAiImportOrder(["a", "ghost", "b"], items)).toHaveLength(0);
  });

  it("all items imported — full reorder", () => {
    // Chain: a → b → c  |  Import: c, a, b  |  Expected: c, a, b
    const items = makeChain(["a", "b", "c"]);
    const order = applyAndResolve(items, computeAiImportOrder(["c", "a", "b"], items));
    expect(order).toEqual(["c", "a", "b"]);
  });
});
