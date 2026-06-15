import { describe, it, expect } from "vitest";
import { computeReorder } from "./reorderLogic.js";

const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("computeReorder", () => {
  it("moves an item forward", () => {
    const result = computeReorder(items, 0, 2);
    expect(result.map((r) => r.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves an item backward", () => {
    const result = computeReorder(items, 3, 1);
    expect(result.map((r) => r.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("positions are contiguous starting from 0", () => {
    const result = computeReorder(items, 1, 3);
    expect(result.map((r) => r.position)).toEqual([0, 1, 2, 3]);
  });

  it("does not mutate the original array", () => {
    const original = [{ id: "x" }, { id: "y" }];
    computeReorder(original, 0, 1);
    expect(original[0].id).toBe("x");
  });

  it("handles a two-item list", () => {
    const two = [{ id: "x" }, { id: "y" }];
    expect(computeReorder(two, 0, 1).map((r) => r.id)).toEqual(["y", "x"]);
    expect(computeReorder(two, 1, 0).map((r) => r.id)).toEqual(["y", "x"]);
  });
});
