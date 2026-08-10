import { describe, it, expect } from "vitest";
import { resolveChain } from "../db/operations.js";

// ---------------------------------------------------------------------------
// Dummy splice logic
// ---------------------------------------------------------------------------
// Mirrors the buildDisplayItems computation in ListView: inserts DUMMY into
// an already-chain-ordered list of real items.

function buildDisplayOrder(
  realItems: { id: string }[],
  dummyAfterId: string | null,
  DUMMY = "__inline_add__",
): string[] {
  const insertIdx =
    dummyAfterId === null
      ? 0
      : (() => {
          const idx = realItems.findIndex((i) => i.id === dummyAfterId);
          return idx === -1 ? realItems.length : idx + 1;
        })();
  return [
    ...realItems.slice(0, insertIdx).map((i) => i.id),
    DUMMY,
    ...realItems.slice(insertIdx).map((i) => i.id),
  ];
}

describe("buildDisplayOrder (dummy splice logic)", () => {
  it("places dummy first in an empty list", () => {
    expect(buildDisplayOrder([], null)).toEqual(["__inline_add__"]);
  });

  it("places dummy first when dummyAfterId is null", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(buildDisplayOrder(items, null)).toEqual(["__inline_add__", "a", "b", "c"]);
  });

  it("places dummy at the tail when dummyAfterId is the last real item", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(buildDisplayOrder(items, "c")).toEqual(["a", "b", "c", "__inline_add__"]);
  });

  it("places dummy after its predecessor in the middle", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(buildDisplayOrder(items, "b")).toEqual(["a", "b", "__inline_add__", "c"]);
  });

  it("places dummy after the first item", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(buildDisplayOrder(items, "a")).toEqual(["a", "__inline_add__", "b", "c"]);
  });

  it("appends dummy at end when its predecessor is missing (filtered or deleted)", () => {
    const items = [{ id: "a" }, { id: "b" }];
    expect(buildDisplayOrder(items, "missing")).toEqual(["a", "b", "__inline_add__"]);
  });

  it("appends dummy at end when list has only one item and dummy follows it", () => {
    expect(buildDisplayOrder([{ id: "a" }], "a")).toEqual(["a", "__inline_add__"]);
  });

  it("prepends dummy when list has only one item and dummyAfterId is null", () => {
    expect(buildDisplayOrder([{ id: "a" }], null)).toEqual(["__inline_add__", "a"]);
  });
});

// ---------------------------------------------------------------------------
// resolveChain fork tiebreak: dummy (created_at: 0) beats real items
// ---------------------------------------------------------------------------

describe("resolveChain with dummy-like item (created_at: 0)", () => {
  it("places created_at:0 item first among siblings with same after_id", () => {
    const items = [
      { id: "a", after_id: null, created_at: 1000 },
      { id: "dummy", after_id: "a", created_at: 0 },  // wins the tie
      { id: "b", after_id: "a", created_at: 2000 },
    ];
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["a", "dummy", "b"]);
  });

  it("positions dummy before all real siblings regardless of their age", () => {
    const items = [
      { id: "root", after_id: null, created_at: 500 },
      { id: "dummy", after_id: "root", created_at: 0 },
      { id: "old", after_id: "root", created_at: 100 },   // old, but not dummy
      { id: "new", after_id: "root", created_at: 9999 },
    ];
    const order = resolveChain(items as any).map((i) => i.id);
    expect(order[0]).toBe("root");
    expect(order[1]).toBe("dummy"); // dummy wins despite old being created_at:100
  });

  it("dummy is placed in the correct depth-first position", () => {
    // Chain: a → b → c; dummy between a and b; b has a child d.
    // Expected depth-first: a, dummy, b, d, c
    const items = [
      { id: "a", after_id: null, created_at: 1 },
      { id: "dummy", after_id: "a", created_at: 0 },
      { id: "b", after_id: "a", created_at: 2 },
      { id: "d", after_id: "b", created_at: 3 },
      { id: "c", after_id: "b", created_at: 4 }, // sibling of d
    ];
    // Note: resolveChain sorts siblings by created_at, so b's children: d, c
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["a", "dummy", "b", "d", "c"]);
  });

  it("dummy at null (first) wins over real head when both have after_id=null", () => {
    const items = [
      { id: "dummy", after_id: null, created_at: 0 },
      { id: "a", after_id: null, created_at: 1 },
    ];
    expect(resolveChain(items as any).map((i) => i.id)).toEqual(["dummy", "a"]);
  });

  it("resolveChain is stable when dummy is the only item", () => {
    const dummy = { id: "dummy", after_id: null, created_at: 0 };
    expect(resolveChain([dummy] as any).map((i) => i.id)).toEqual(["dummy"]);
  });
});

// ---------------------------------------------------------------------------
// Dummy advance logic: after creating an item, dummy moves to after it
// ---------------------------------------------------------------------------

describe("dummy resets to tail after inline add", () => {
  // After any add (Enter or modal), the dummy position is cleared so it
  // defaults to the tail. resolvedDummyAfterId returns items[last].id when
  // no explicit position is set.

  it("after adding in the middle, dummy resets to the new tail", () => {
    // Real chain before add: a → b; dummy at after_id=a (before b)
    // User adds 'n' at dummy's position → chain becomes a → n → b
    // Dummy resets to tail: after 'b'
    const realItemsAfterAdd = [
      { id: "a", after_id: null, created_at: 1 },
      { id: "n", after_id: "a", created_at: 2 },
      { id: "b", after_id: "n", created_at: 3 },
    ];
    // tail is "b", so dummyAfterId = "b"
    const order = buildDisplayOrder(realItemsAfterAdd, "b");
    expect(order).toEqual(["a", "n", "b", "__inline_add__"]);
  });

  it("after a tail insert, dummy stays at the new tail", () => {
    // Real chain: a → b → c; dummy at c (tail); user adds n after c
    // Dummy resets to tail: after 'n'
    const realItems = [
      { id: "a", after_id: null },
      { id: "b", after_id: "a" },
      { id: "c", after_id: "b" },
      { id: "n", after_id: "c" },
    ];
    const order = buildDisplayOrder(realItems, "n");
    expect(order).toEqual(["a", "b", "c", "n", "__inline_add__"]);
  });

  it("after a prepend, dummy resets to the tail (not after the new head)", () => {
    // Real chain: a → b; dummy at null (top); user adds n at top
    // createItem patches a.after_id = n; chain: n → a → b
    // Dummy resets to tail: after 'b'
    const realItems = [
      { id: "n", after_id: null },
      { id: "a", after_id: "n" },
      { id: "b", after_id: "a" },
    ];
    const order = buildDisplayOrder(realItems, "b");
    expect(order).toEqual(["n", "a", "b", "__inline_add__"]);
  });
});
