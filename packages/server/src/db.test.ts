import { describe, it, expect, beforeEach } from "vitest";
import { ENTITY_SCHEMA_VERSION } from "@listr/shared";
import { openDb } from "./db.js";

type DbApi = ReturnType<typeof openDb>;

const KEY = "testkey";

function makeList(id: string, updatedAt: number) {
  return { id, updated_at: updatedAt, name: "Test", board_id: "b1" };
}

function makeItem(id: string, updatedAt: number) {
  return { id, updated_at: updatedAt, title: "Test", list_id: "l1", after_id: null, schema_version: ENTITY_SCHEMA_VERSION };
}

function makeBoard(id: string, updatedAt: number) {
  return { id, updated_at: updatedAt, name: "Test" };
}

// ── upsertEntity: entity vs entity ────────────────────────────────────────────

describe("upsertEntity — entity vs entity LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("inserts a new entity when none exists", () => {
    const accepted = db.upsertEntity("list", makeList("l1", 100), KEY);
    expect(accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("overwrites when incoming is newer", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);
    const accepted = db.upsertEntity("list", { ...makeList("l1", 200), name: "Updated" }, KEY);
    expect(accepted).toBe(true);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.name).toBe("Updated");
    expect(stored.updated_at).toBe(200);
  });

  it("rejects incoming when same age", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);
    const accepted = db.upsertEntity("list", { ...makeList("l1", 100), name: "Same" }, KEY);
    expect(accepted).toBe(false);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.name).toBe("Test");
  });

  it("rejects incoming when older", () => {
    db.upsertEntity("list", makeList("l1", 200), KEY);
    const accepted = db.upsertEntity("list", { ...makeList("l1", 100), name: "Old" }, KEY);
    expect(accepted).toBe(false);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.updated_at).toBe(200);
  });

  it("works the same for boards and items", () => {
    expect(db.upsertEntity("board", makeBoard("b1", 100), KEY)).toBe(true);
    expect(db.upsertEntity("board", makeBoard("b1", 50), KEY)).toBe(false);
    expect(db.upsertEntity("item", makeItem("i1", 100), KEY)).toBe(true);
    expect(db.upsertEntity("item", makeItem("i1", 200), KEY)).toBe(true);
  });
});

// ── upsertEntity: item schema_version format gate ─────────────────────────────

describe("upsertEntity — item format gate", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("rejects an item with no schema_version (legacy blob)", () => {
    const legacy = { id: "i1", updated_at: 100, title: "Old", list_id: "l1", position: 0 };
    expect(db.upsertEntity("item", legacy, KEY)).toBe(false);
    expect(db.getEntitiesSince("item", KEY, 0)).toHaveLength(0);
  });

  it("rejects an item with an older schema_version", () => {
    const old = { id: "i1", updated_at: 100, title: "Old", list_id: "l1", schema_version: ENTITY_SCHEMA_VERSION - 1 };
    expect(db.upsertEntity("item", old, KEY)).toBe(false);
  });

  it("does not let a legacy re-push overwrite a stored current item", () => {
    expect(db.upsertEntity("item", makeItem("i1", 100), KEY)).toBe(true);
    const legacyNewer = { id: "i1", updated_at: 999, title: "Regressed", list_id: "l1", position: 0 };
    expect(db.upsertEntity("item", legacyNewer, KEY)).toBe(false);
    const [stored] = db.getEntitiesSince("item", KEY, 0) as any[];
    expect(stored.title).toBe("Test");
    expect(stored.schema_version).toBe(ENTITY_SCHEMA_VERSION);
  });

  it("still gates only items — boards/lists are unaffected", () => {
    expect(db.upsertEntity("board", makeBoard("b1", 100), KEY)).toBe(true);
    expect(db.upsertEntity("list", makeList("l1", 100), KEY)).toBe(true);
  });
});

// ── upsertEntity: entity vs tombstone ─────────────────────────────────────────

describe("upsertEntity — entity vs tombstone LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("accepts entity when no tombstone exists", () => {
    expect(db.upsertEntity("list", makeList("l1", 100), KEY)).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("accepts entity when entity is newer than tombstone (entity wins)", () => {
    db.applyTombstone("list", "l1", 100, KEY);   // tombstone deleted_at=100
    const accepted = db.upsertEntity("list", makeList("l1", 200), KEY);  // entity updated_at=200
    expect(accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("rejects entity when same age as tombstone (tombstone wins)", () => {
    db.applyTombstone("list", "l1", 100, KEY);
    const accepted = db.upsertEntity("list", makeList("l1", 100), KEY);
    expect(accepted).toBe(false);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("rejects entity when tombstone is newer (tombstone wins)", () => {
    db.applyTombstone("list", "l1", 200, KEY);   // tombstone deleted_at=200
    const accepted = db.upsertEntity("list", makeList("l1", 100), KEY);  // entity updated_at=100
    expect(accepted).toBe(false);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("does not resurrect a deleted item that a stale client re-pushes", () => {
    // Entity created at 100, deleted at 200, stale client re-pushes the old version
    db.upsertEntity("item", makeItem("i1", 100), KEY);
    db.applyTombstone("item", "i1", 200, KEY);
    const accepted = db.upsertEntity("item", makeItem("i1", 100), KEY);  // stale re-push
    expect(accepted).toBe(false);
    expect(db.getEntitiesSince("item", KEY, 0)).toHaveLength(0);
  });
});

// ── applyTombstone: tombstone vs tombstone ────────────────────────────────────

describe("applyTombstone — tombstone vs tombstone LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("records a new tombstone", () => {
    const accepted = db.applyTombstone("list", "l1", 100, KEY);
    expect(accepted).toBe(true);
    expect(db.getTombstonesSince(KEY, 0)).toHaveLength(1);
  });

  it("updates when incoming tombstone is newer", () => {
    db.applyTombstone("list", "l1", 100, KEY);
    const accepted = db.applyTombstone("list", "l1", 200, KEY);
    expect(accepted).toBe(true);
    const [t] = db.getTombstonesSince(KEY, 0);
    expect(t.deleted_at).toBe(200);
  });

  it("rejects when incoming tombstone is same age", () => {
    db.applyTombstone("list", "l1", 100, KEY);
    expect(db.applyTombstone("list", "l1", 100, KEY)).toBe(false);
  });

  it("rejects when incoming tombstone is older", () => {
    db.applyTombstone("list", "l1", 200, KEY);
    const accepted = db.applyTombstone("list", "l1", 100, KEY);
    expect(accepted).toBe(false);
    const [t] = db.getTombstonesSince(KEY, 0);
    expect(t.deleted_at).toBe(200);
  });

  it("tombstones for different entity types are independent", () => {
    db.applyTombstone("list", "e1", 200, KEY);
    const accepted = db.applyTombstone("item", "e1", 100, KEY);
    expect(accepted).toBe(true);
    expect(db.getTombstonesSince(KEY, 0)).toHaveLength(2);
  });
});

// ── applyTombstone: tombstone vs entity (entity deletion) ─────────────────────

describe("applyTombstone — entity deletion LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("deletes entity older than tombstone (tombstone wins)", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);   // entity updated_at=100
    db.applyTombstone("list", "l1", 200, KEY);            // tombstone deleted_at=200
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("deletes entity at same timestamp as tombstone (tombstone wins)", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);
    db.applyTombstone("list", "l1", 100, KEY);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("preserves entity newer than tombstone (entity wins)", () => {
    db.upsertEntity("list", makeList("l1", 300), KEY);   // entity updated_at=300
    db.applyTombstone("list", "l1", 200, KEY);            // tombstone deleted_at=200
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("is a no-op when no entity exists", () => {
    const accepted = db.applyTombstone("list", "l1", 100, KEY);
    expect(accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("stale client re-pushes cannot undo a deletion that came after", () => {
    // Timeline: create at 100, delete at 200, stale client reconnects and pushes old version
    db.upsertEntity("list", makeList("l1", 100), KEY);
    db.applyTombstone("list", "l1", 200, KEY);           // entity deleted
    db.upsertEntity("list", makeList("l1", 100), KEY);   // stale re-push rejected
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("entity updated after deletion survives the old tombstone", () => {
    // Timeline: create at 100, delete at 200, then re-created at 300
    db.applyTombstone("list", "l1", 200, KEY);
    db.upsertEntity("list", makeList("l1", 300), KEY);   // newer than tombstone → accepted
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
    // Old tombstone arriving again must not delete the newer entity
    db.applyTombstone("list", "l1", 200, KEY);           // rejected (existing tombstone same age)
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });
});
