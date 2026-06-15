import { describe, it, expect } from "vitest";
import { applyIncomingEntity } from "./mergeLogic.js";

function makeList(id: string, updatedAt: number, viewMode = "list") {
  return { id, updated_at: updatedAt, view_mode: viewMode, name: "Test List" };
}

describe("applyIncomingEntity — view_mode isolation", () => {
  it("applies newer incoming list but keeps local view_mode", () => {
    const incoming = makeList("l1", 2000, "table");
    const existing = makeList("l1", 1000, "card");
    const result = applyIncomingEntity("list", incoming, existing);
    expect(result).not.toBeNull();
    expect(result!.view_mode).toBe("card");   // local preserved
    expect(result!.name).toBe("Test List");   // other fields from incoming
    expect(result!.updated_at).toBe(2000);
  });

  it("uses incoming view_mode when no local copy exists yet", () => {
    const incoming = makeList("l1", 2000, "table");
    const result = applyIncomingEntity("list", incoming, undefined);
    expect(result).not.toBeNull();
    expect(result!.view_mode).toBe("table");
  });

  it("rejects incoming list that is older than local", () => {
    const incoming = makeList("l1", 500, "table");
    const existing = makeList("l1", 1000, "card");
    expect(applyIncomingEntity("list", incoming, existing)).toBeNull();
  });

  it("rejects incoming list with the same timestamp (no-op)", () => {
    const incoming = makeList("l1", 1000, "table");
    const existing = makeList("l1", 1000, "card");
    expect(applyIncomingEntity("list", incoming, existing)).toBeNull();
  });
});

describe("applyIncomingEntity — categories and items", () => {
  it("applies newer category normally", () => {
    const incoming = { id: "c1", updated_at: 2000, name: "Movies" };
    const existing = { id: "c1", updated_at: 1000, name: "Old" };
    const result = applyIncomingEntity("category", incoming, existing);
    expect(result).toEqual(incoming);
  });

  it("applies newer item normally", () => {
    const incoming = { id: "i1", updated_at: 2000, title: "New" };
    const existing = { id: "i1", updated_at: 1000, title: "Old" };
    const result = applyIncomingEntity("item", incoming, existing);
    expect(result).toEqual(incoming);
  });

  it("rejects older item", () => {
    const incoming = { id: "i1", updated_at: 1000, title: "Old" };
    const existing = { id: "i1", updated_at: 2000, title: "New" };
    expect(applyIncomingEntity("item", incoming, existing)).toBeNull();
  });
});
