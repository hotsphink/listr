import { describe, it, expect } from "vitest";
import { computeReorder } from "./reorderLogic.js";

// Items with sparse positions (step 64) — the normal steady state
const sparse = [
  { id: "a", position: 0 },
  { id: "b", position: 64 },
  { id: "c", position: 128 },
  { id: "d", position: 192 },
];

// Items with dense/contiguous positions — triggers full renumber
const dense = [
  { id: "a", position: 0 },
  { id: "b", position: 1 },
  { id: "c", position: 2 },
  { id: "d", position: 3 },
];

describe("computeReorder — sparse insertion (no renumber)", () => {
  it("inserts between two items using their mean", () => {
    // Move a (0) to index 2: neighbors become c(128) and d(192), mean=160
    const result = computeReorder(sparse, 0, 2);
    expect(result).toEqual([{ id: "a", position: 160 }]);
  });

  it("moves to end using prev + 64", () => {
    // Move a (0) to after d(192): prev=d(192), no next → 192+64=256
    const result = computeReorder(sparse, 0, 3);
    expect(result).toEqual([{ id: "a", position: 256 }]);
  });

  it("moves to beginning using next - 64", () => {
    // Move d (192) to before a(0): next=a(0), no prev → 0-64=-64
    const result = computeReorder(sparse, 3, 0);
    expect(result).toEqual([{ id: "d", position: -64 }]);
  });

  it("only returns the one moved item", () => {
    const result = computeReorder(sparse, 1, 3);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("b");
  });
});

describe("computeReorder — full renumber on collision", () => {
  it("renumbers all items when mean collides", () => {
    // Move a (0) to index 2: neighbors c(2) and d(3), mean=2.5→3 which collides with d(3)
    const result = computeReorder(dense, 0, 2);
    // New order: b, c, a, d
    expect(result).toEqual([
      { id: "b", position: 0 },
      { id: "c", position: 64 },
      { id: "a", position: 128 },
      { id: "d", position: 192 },
    ]);
  });

  it("renumbers all items and returns them in new order", () => {
    // Move a (0) to index 3 (end): prev=d(3), next=none → 3+64=67, no collision
    // Actually that won't collide. Use a different dense case that does collide.
    // Move b (1) to index 2: neighbors c(2) and d(3), mean=2.5→3 which collides with d(3)
    const result = computeReorder(dense, 1, 2);
    // New order: a, c, b, d
    expect(result).toEqual([
      { id: "a", position: 0 },
      { id: "c", position: 64 },
      { id: "b", position: 128 },
      { id: "d", position: 192 },
    ]);
  });
});

describe("computeReorder — two-item list", () => {
  const two = [
    { id: "x", position: 0 },
    { id: "y", position: 64 },
  ];

  it("moves first to end", () => {
    // x (0) after y (64): prev=y(64), no next → 64+64=128
    expect(computeReorder(two, 0, 1)).toEqual([{ id: "x", position: 128 }]);
  });

  it("moves last to beginning", () => {
    // y (64) before x (0): no prev, next=x(0) → 0-64=-64
    expect(computeReorder(two, 1, 0)).toEqual([{ id: "y", position: -64 }]);
  });
});

describe("computeReorder — edge cases", () => {
  it("returns empty array when oldIndex equals newIndex", () => {
    expect(computeReorder(sparse, 1, 1)).toEqual([]);
  });

  it("returns empty array for a single-item list", () => {
    expect(computeReorder([{ id: "a", position: 0 }], 0, 0)).toEqual([]);
  });

  it("does not mutate the original array", () => {
    const original = [
      { id: "x", position: 0 },
      { id: "y", position: 64 },
    ];
    computeReorder(original, 0, 1);
    expect(original[0].id).toBe("x");
    expect(original[0].position).toBe(0);
  });
});
