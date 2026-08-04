import { describe, it, expect } from "vitest";
import { computeChainInsert, computeChainDelete, computeCrossListMove, resolveChain } from "./operations.js";

// Build a chain from an ordered array of ids.
function chain(ids: string[]): { id: string; after_id: string | null }[] {
  return ids.map((id, i) => ({ id, after_id: i === 0 ? null : ids[i - 1] }));
}

// Apply after_id patches to a set of items and return the resolved display order.
function applyAndOrder(
  items: { id: string; after_id: string | null }[],
  updates: { id: string; after_id: string | null }[],
): string[] {
  const m = new Map(updates.map((u) => [u.id, u.after_id]));
  return resolveChain(
    items.map((i) => ({ ...i, after_id: m.has(i.id) ? m.get(i.id)! : i.after_id })) as any,
  ).map((i) => i.id);
}

// ---------------------------------------------------------------------------
// computeChainInsert
// ---------------------------------------------------------------------------

describe("computeChainInsert", () => {
  it("returns null when inserting into an empty list", () => {
    expect(computeChainInsert([], null, "new")).toBeNull();
  });

  it("returns null when inserting at the tail (nobody follows the predecessor)", () => {
    const items = chain(["a", "b", "c"]);
    expect(computeChainInsert(items, "c", "new")).toBeNull();
  });

  it("displaces the head when inserting at the front (predecessorId = null)", () => {
    const items = chain(["a", "b", "c"]);
    expect(computeChainInsert(items, null, "new")).toEqual({ id: "a", after_id: "new" });
  });

  it("displaces the item that used to follow the insertion point", () => {
    const items = chain(["a", "b", "c"]);
    // Inserting after "a": "b" (which follows "a") must now follow "new"
    expect(computeChainInsert(items, "a", "new")).toEqual({ id: "b", after_id: "new" });
  });

  it("produces a valid chain when applied — insert at front", () => {
    const items = chain(["a", "b", "c"]);
    const newItem = { id: "new", after_id: null };
    const displaced = computeChainInsert(items, null, "new");
    expect(applyAndOrder([...items, newItem], displaced ? [displaced] : [])).toEqual(["new", "a", "b", "c"]);
  });

  it("produces a valid chain when applied — insert in middle", () => {
    const items = chain(["a", "b", "c"]);
    const newItem = { id: "new", after_id: "b" };
    const displaced = computeChainInsert(items, "b", "new");
    expect(applyAndOrder([...items, newItem], displaced ? [displaced] : [])).toEqual(["a", "b", "new", "c"]);
  });

  it("produces a valid chain when applied — insert at tail", () => {
    const items = chain(["a", "b", "c"]);
    const newItem = { id: "new", after_id: "c" };
    const displaced = computeChainInsert(items, "c", "new");
    expect(applyAndOrder([...items, newItem], displaced ? [displaced] : [])).toEqual(["a", "b", "c", "new"]);
  });
});

// ---------------------------------------------------------------------------
// computeChainDelete
// ---------------------------------------------------------------------------

describe("computeChainDelete", () => {
  it("re-links the successor when deleting a middle item", () => {
    const items = chain(["a", "b", "c"]);
    // "c" follows "b"; after deleting "b" it should follow "a" (b's predecessor)
    expect(computeChainDelete(items, "b", "a")).toEqual([{ id: "c", after_id: "a" }]);
  });

  it("makes the successor the new head when deleting the head item", () => {
    const items = chain(["a", "b", "c"]);
    // "b" follows "a"; after deleting "a" it should be the new head (after_id = null)
    expect(computeChainDelete(items, "a", null)).toEqual([{ id: "b", after_id: null }]);
  });

  it("returns no updates when deleting the tail (no successor)", () => {
    const items = chain(["a", "b", "c"]);
    expect(computeChainDelete(items, "c", "b")).toEqual([]);
  });

  it("returns no updates when deleting the only item", () => {
    const items = chain(["a"]);
    expect(computeChainDelete(items, "a", null)).toEqual([]);
  });

  it("re-links all branches when a forked item is deleted", () => {
    // Fork: both "b" and "x" claim to follow "a"
    const items = [
      { id: "a", after_id: null },
      { id: "b", after_id: "a" },
      { id: "x", after_id: "a" },
    ];
    const updates = computeChainDelete(items, "a", null);
    expect(updates).toHaveLength(2);
    expect(updates).toContainEqual({ id: "b", after_id: null });
    expect(updates).toContainEqual({ id: "x", after_id: null });
  });

  it("produces a valid chain when applied — delete middle", () => {
    const items = chain(["a", "b", "c", "d"]);
    const updates = computeChainDelete(items, "b", "a");
    const remaining = items.filter((i) => i.id !== "b");
    expect(applyAndOrder(remaining, updates)).toEqual(["a", "c", "d"]);
  });

  it("produces a valid chain when applied — delete head", () => {
    const items = chain(["a", "b", "c"]);
    const updates = computeChainDelete(items, "a", null);
    const remaining = items.filter((i) => i.id !== "a");
    expect(applyAndOrder(remaining, updates)).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// computeCrossListMove
// ---------------------------------------------------------------------------

describe("computeCrossListMove", () => {
  it("re-links both source and target chains when moving a middle item", () => {
    // source: s1 → s2 → s3 (moving s2); target: t1 → t2 → t3 (inserting after t1)
    const src = chain(["s1", "s2", "s3"]);
    const tgt = chain(["t1", "t2", "t3"]);
    const { sourceSuccessorUpdate, targetSuccessorUpdate } = computeCrossListMove(src, tgt, "s2", "s1", "t1");
    // s3 was after s2; it should now follow s1
    expect(sourceSuccessorUpdate).toEqual({ id: "s3", after_id: "s1" });
    // t2 was after t1; it should now follow s2
    expect(targetSuccessorUpdate).toEqual({ id: "t2", after_id: "s2" });
  });

  it("makes source successor the new head when moving the source head", () => {
    const src = chain(["s1", "s2", "s3"]); // moving s1 (head, after_id = null)
    const tgt = chain(["t1"]);
    const { sourceSuccessorUpdate } = computeCrossListMove(src, tgt, "s1", null, "t1");
    // s2 was after s1; it should now be the new source head
    expect(sourceSuccessorUpdate).toEqual({ id: "s2", after_id: null });
  });

  it("returns null sourceSuccessorUpdate when moving the source tail", () => {
    const src = chain(["s1", "s2"]); // moving s2 (tail)
    const tgt = chain(["t1"]);
    const { sourceSuccessorUpdate } = computeCrossListMove(src, tgt, "s2", "s1", "t1");
    expect(sourceSuccessorUpdate).toBeNull();
  });

  it("returns null targetSuccessorUpdate when inserting at the end of target", () => {
    const src = chain(["s1", "s2"]);
    const tgt = chain(["t1", "t2"]); // inserting after t2 (the tail)
    const { targetSuccessorUpdate } = computeCrossListMove(src, tgt, "s1", null, "t2");
    expect(targetSuccessorUpdate).toBeNull();
  });

  it("returns null targetSuccessorUpdate when inserting into an empty target", () => {
    const { sourceSuccessorUpdate, targetSuccessorUpdate } = computeCrossListMove(
      chain(["s1"]), [], "s1", null, null,
    );
    expect(sourceSuccessorUpdate).toBeNull();
    expect(targetSuccessorUpdate).toBeNull();
  });

  it("handles inserting at the front of target (predecessorId = null)", () => {
    const src = chain(["s1"]);
    const tgt = chain(["t1", "t2"]);
    const { targetSuccessorUpdate } = computeCrossListMove(src, tgt, "s1", null, null);
    // t1 was the head; it must now follow the moved item
    expect(targetSuccessorUpdate).toEqual({ id: "t1", after_id: "s1" });
  });

  it("produces a valid source chain after move", () => {
    const src = chain(["s1", "s2", "s3"]);
    const tgt = chain(["t1"]);
    const { sourceSuccessorUpdate } = computeCrossListMove(src, tgt, "s2", "s1", "t1");
    const remaining = src.filter((i) => i.id !== "s2");
    expect(applyAndOrder(remaining, sourceSuccessorUpdate ? [sourceSuccessorUpdate] : [])).toEqual(["s1", "s3"]);
  });

  it("produces a valid target chain after move", () => {
    const src = chain(["s1", "s2", "s3"]);
    const tgt = chain(["t1", "t2", "t3"]);
    const { targetSuccessorUpdate } = computeCrossListMove(src, tgt, "s2", "s1", "t1");
    const movedInTarget = { id: "s2", after_id: "t1" };
    const updates = [movedInTarget, ...(targetSuccessorUpdate ? [targetSuccessorUpdate] : [])];
    expect(applyAndOrder([...tgt, movedInTarget], updates)).toEqual(["t1", "s2", "t2", "t3"]);
  });
});
