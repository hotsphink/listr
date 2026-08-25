import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function makeAsset(id: string, updatedAt: number) {
  return { id, updated_at: updatedAt, created_at: updatedAt, mime_type: "image/png", ext: "png", filename: "x.png", size: 10, data: "abc" };
}

// Builds a database file on disk shaped like a pre-this-change deployment:
// old user_keys column name, no asset_keys table, no schema_version row at
// all. Used to exercise the baseline/upgrade path in applyMigrations, which
// :memory: databases can't (they never persist between opens).
function makeLegacyDbFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "listr-test-"));
  const path = join(dir, "legacy.db");
  const raw = new Database(path);
  raw.exec(`
    CREATE TABLE server_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE boards (id TEXT PRIMARY KEY, sync_key TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE lists (id TEXT PRIMARY KEY, sync_key TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE items (id TEXT PRIMARY KEY, sync_key TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE tombstones (id TEXT PRIMARY KEY, sync_key TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, deleted_at INTEGER NOT NULL);
    CREATE TABLE integration_results (id TEXT PRIMARY KEY, sync_key TEXT NOT NULL, item_id TEXT NOT NULL, integration_id TEXT NOT NULL, status TEXT NOT NULL, attribute_values TEXT, integration_data TEXT, error TEXT, created_at INTEGER, updated_at INTEGER NOT NULL);
    CREATE TABLE user_keys (user_key TEXT NOT NULL, key TEXT NOT NULL, name TEXT, added_at INTEGER NOT NULL, PRIMARY KEY (user_key, key));
  `);
  raw
    .prepare(`INSERT INTO boards (id, sync_key, updated_at, data) VALUES (?, ?, ?, ?)`)
    .run("b1", "sharedKey", 100, JSON.stringify({ id: "b1", sync_key: "sharedKey", updated_at: 100, name: "Legacy", format_string: "![img](hash://legacyasset0000001.png)" }));
  raw.prepare(`INSERT INTO assets (id, updated_at, data) VALUES (?, ?, ?)`).run("legacyasset0000001", 90, JSON.stringify(makeAsset("legacyasset0000001", 90)));
  raw.prepare(`INSERT INTO assets (id, updated_at, data) VALUES (?, ?, ?)`).run("orphanasset00000001", 80, JSON.stringify(makeAsset("orphanasset00000001", 80)));
  raw.prepare(`INSERT INTO user_keys (user_key, key, name, added_at) VALUES (?, ?, ?, ?)`).run("home1", "grp1", null, 100);
  raw.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// ── upsertEntity: entity vs entity ────────────────────────────────────────────

describe("upsertEntity — entity vs entity LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("inserts a new entity when none exists", () => {
    const { accepted } = db.upsertEntity("list", makeList("l1", 100), KEY);
    expect(accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("overwrites when incoming is newer", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);
    const { accepted } = db.upsertEntity("list", { ...makeList("l1", 200), name: "Updated" }, KEY);
    expect(accepted).toBe(true);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.name).toBe("Updated");
    expect(stored.updated_at).toBe(200);
  });

  it("rejects incoming when same age", () => {
    db.upsertEntity("list", makeList("l1", 100), KEY);
    const { accepted } = db.upsertEntity("list", { ...makeList("l1", 100), name: "Same" }, KEY);
    expect(accepted).toBe(false);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.name).toBe("Test");
  });

  it("rejects incoming when older", () => {
    db.upsertEntity("list", makeList("l1", 200), KEY);
    const { accepted } = db.upsertEntity("list", { ...makeList("l1", 100), name: "Old" }, KEY);
    expect(accepted).toBe(false);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.updated_at).toBe(200);
  });

  it("works the same for boards and items", () => {
    expect(db.upsertEntity("board", makeBoard("b1", 100), KEY).accepted).toBe(true);
    expect(db.upsertEntity("board", makeBoard("b1", 50), KEY).accepted).toBe(false);
    expect(db.upsertEntity("item", makeItem("i1", 100), KEY).accepted).toBe(true);
    expect(db.upsertEntity("item", makeItem("i1", 200), KEY).accepted).toBe(true);
  });
});

// ── upsertEntity: item schema_version format gate ─────────────────────────────

describe("upsertEntity — item format gate", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("rejects an item with no schema_version (legacy blob)", () => {
    const legacy = { id: "i1", updated_at: 100, title: "Old", list_id: "l1", position: 0 };
    expect(db.upsertEntity("item", legacy, KEY).accepted).toBe(false);
    expect(db.getEntitiesSince("item", KEY, 0)).toHaveLength(0);
  });

  it("rejects an item with an older schema_version", () => {
    const old = { id: "i1", updated_at: 100, title: "Old", list_id: "l1", schema_version: ENTITY_SCHEMA_VERSION - 1 };
    expect(db.upsertEntity("item", old, KEY).accepted).toBe(false);
  });

  it("does not let a legacy re-push overwrite a stored current item", () => {
    expect(db.upsertEntity("item", makeItem("i1", 100), KEY).accepted).toBe(true);
    const legacyNewer = { id: "i1", updated_at: 999, title: "Regressed", list_id: "l1", position: 0 };
    expect(db.upsertEntity("item", legacyNewer, KEY).accepted).toBe(false);
    const [stored] = db.getEntitiesSince("item", KEY, 0) as any[];
    expect(stored.title).toBe("Test");
    expect(stored.schema_version).toBe(ENTITY_SCHEMA_VERSION);
  });

  it("still gates only items — boards/lists are unaffected", () => {
    expect(db.upsertEntity("board", makeBoard("b1", 100), KEY).accepted).toBe(true);
    expect(db.upsertEntity("list", makeList("l1", 100), KEY).accepted).toBe(true);
  });
});

// ── upsertEntity: entity vs tombstone ─────────────────────────────────────────

describe("upsertEntity — entity vs tombstone LWW", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("accepts entity when no tombstone exists", () => {
    expect(db.upsertEntity("list", makeList("l1", 100), KEY).accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("accepts entity when entity is newer than tombstone (entity wins)", () => {
    db.applyTombstone("list", "l1", 100, KEY);   // tombstone deleted_at=100
    const { accepted } = db.upsertEntity("list", makeList("l1", 200), KEY);  // entity updated_at=200
    expect(accepted).toBe(true);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });

  it("rejects entity when same age as tombstone (tombstone wins)", () => {
    db.applyTombstone("list", "l1", 100, KEY);
    const { accepted } = db.upsertEntity("list", makeList("l1", 100), KEY);
    expect(accepted).toBe(false);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("rejects entity when tombstone is newer (tombstone wins)", () => {
    db.applyTombstone("list", "l1", 200, KEY);   // tombstone deleted_at=200
    const { accepted } = db.upsertEntity("list", makeList("l1", 100), KEY);  // entity updated_at=100
    expect(accepted).toBe(false);
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(0);
  });

  it("does not resurrect a deleted item that a stale client re-pushes", () => {
    // Entity created at 100, deleted at 200, stale client re-pushes the old version
    db.upsertEntity("item", makeItem("i1", 100), KEY);
    db.applyTombstone("item", "i1", 200, KEY);
    const { accepted } = db.upsertEntity("item", makeItem("i1", 100), KEY);  // stale re-push
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

// ── user_keys: server-side user/key-group association ──────────────────────

describe("user_keys", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("associates a key with a user and returns it via getUserKeys", () => {
    db.associateUserKey("default1", "group1", null);
    expect(db.getUserKeys("default1")).toEqual([{ key: "group1", name: null }]);
  });

  it("returns nothing for a user with no associations", () => {
    expect(db.getUserKeys("default1")).toEqual([]);
  });

  it("keeps associations for different users separate", () => {
    db.associateUserKey("default1", "group1", null);
    db.associateUserKey("default2", "group2", null);
    expect(db.getUserKeys("default1")).toEqual([{ key: "group1", name: null }]);
    expect(db.getUserKeys("default2")).toEqual([{ key: "group2", name: null }]);
  });

  it("re-associating with a name upgrades a previously unnamed key", () => {
    db.associateUserKey("default1", "group1", null);
    db.associateUserKey("default1", "group1", "Team Trip");
    expect(db.getUserKeys("default1")).toEqual([{ key: "group1", name: "Team Trip" }]);
  });

  it("re-associating with a null name does not clobber an existing name", () => {
    db.associateUserKey("default1", "group1", "Team Trip");
    db.associateUserKey("default1", "group1", null);
    expect(db.getUserKeys("default1")).toEqual([{ key: "group1", name: "Team Trip" }]);
  });

  it("removeUserKey drops the association", () => {
    db.associateUserKey("default1", "group1", "Team Trip");
    db.removeUserKey("default1", "group1");
    expect(db.getUserKeys("default1")).toEqual([]);
  });

  it("removeUserKey on a nonexistent association is a no-op", () => {
    expect(() => db.removeUserKey("default1", "group1")).not.toThrow();
  });
});

// ── updated_at / deleted_at clamped to server time (§11.2.2) ─────────────────

describe("upsertEntity — clamps updated_at to server time", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("clamps a far-future updated_at instead of storing it verbatim", () => {
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365; // a year out
    const { accepted } = db.upsertEntity("list", makeList("l1", farFuture), KEY);
    expect(accepted).toBe(true);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.updated_at).toBeLessThan(farFuture);
    expect(stored.updated_at).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
  });

  it("does not clamp a timestamp within the skew allowance", () => {
    const nearFuture = Date.now() + 60_000; // 1 minute ahead, well under the allowance
    db.upsertEntity("list", makeList("l1", nearFuture), KEY);
    const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
    expect(stored.updated_at).toBe(nearFuture);
  });

  it("clamped updated_at agrees between the column and the stored JSON", () => {
    // getEntitiesSince filters on the `updated_at` column but reads the value
    // back out of the JSON `data` blob — if clamping mutated one and not the
    // other, a future `since` query keyed on the real column value wouldn't
    // find this row even though the returned object still claims to be from
    // the future.
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365;
    db.upsertEntity("board", makeBoard("b1", farFuture), KEY);
    const [stored] = db.getEntitiesSince("board", KEY, 0) as any[];
    expect(stored.updated_at).toBeLessThan(farFuture);
    expect(db.getEntitiesSince("board", KEY, stored.updated_at - 1)).toHaveLength(1);
  });

  it("an honest edit is no longer blocked once real time catches up past the skew window", () => {
    // The clamp reduces "permanently unbeatable" to "unbeatable for up to the
    // skew window" — it can't reduce it to zero, since the clamped value is
    // itself server-time-plus-skew. Demonstrate the recovery by controlling
    // the clock directly instead of relying on wall-clock time actually
    // passing during the test.
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const farFuture = t0 + 1000 * 60 * 60 * 24 * 365;
      db.upsertEntity("list", makeList("l1", farFuture), KEY); // clamped to ~t0 + 5min

      vi.setSystemTime(t0 + 6 * 60 * 1000); // past the 5-minute skew allowance
      const { accepted } = db.upsertEntity("list", { ...makeList("l1", Date.now()), name: "Fixed" }, KEY);
      expect(accepted).toBe(true);
      const [stored] = db.getEntitiesSince("list", KEY, 0) as any[];
      expect(stored.name).toBe("Fixed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applyTombstone — clamps deleted_at to server time", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("clamps a far-future deleted_at instead of storing it verbatim", () => {
    const farFuture = Date.now() + 1000 * 60 * 60 * 24 * 365;
    db.applyTombstone("list", "l1", farFuture, KEY);
    const [t] = db.getTombstonesSince(KEY, 0);
    expect(t.deleted_at).toBeLessThan(farFuture);
    expect(t.deleted_at).toBeLessThanOrEqual(Date.now() + 5 * 60 * 1000 + 1000);
  });

  it("does not clamp a deleted_at within the skew allowance", () => {
    const nearFuture = Date.now() + 60_000;
    db.applyTombstone("list", "l1", nearFuture, KEY);
    const [t] = db.getTombstonesSince(KEY, 0);
    expect(t.deleted_at).toBe(nearFuture);
  });
});

// ── assets: per-key isolation via asset_keys (§2.1 defect 2) ─────────────────

describe("assets — per-key isolation via asset_keys", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("an asset pushed under one sync_key is invisible to a different key", () => {
    db.upsertEntity("asset", makeAsset("asset1", 100), "keyA");
    expect(db.getEntitiesSince("asset", "keyA", 0)).toHaveLength(1);
    expect(db.getEntitiesSince("asset", "keyB", 0)).toHaveLength(0);
  });

  it("does not leak to a key it was never associated with (regression for the global leak)", () => {
    db.upsertEntity("asset", makeAsset("leakcheck1", 100), "ownerKey");
    db.upsertEntity("asset", makeAsset("leakcheck2", 100), "otherOwnerKey");
    expect(db.getEntitiesSince("asset", "ownerKey", 0)).toHaveLength(1);
    expect(db.getEntitiesSince("asset", "otherOwnerKey", 0)).toHaveLength(1);
    // Nobody sees both just by asking with a since=0 pull on their own key.
    expect((db.getEntitiesSince("asset", "ownerKey", 0)[0] as any).id).toBe("leakcheck1");
  });

  it("an asset referenced in a pushed board's data is associated with that board's key too", () => {
    // Mirrors what actually happens: a fresh image is always pushed under the
    // uploader's own key (no board context at asset-push time), and only
    // becomes visible on a shared board once something referencing it is
    // pushed under the board's own sync_key.
    db.upsertEntity("asset", makeAsset("referencedasset0001", 100), "uploaderKey");
    db.upsertEntity(
      "board",
      { id: "b1", updated_at: 100, name: "B", format_string: "![img](hash://referencedasset0001.png)" },
      "sharedBoardKey",
    );
    expect(db.getEntitiesSince("asset", "sharedBoardKey", 0)).toHaveLength(1);
    // And the uploader's own key still sees it too — association is additive.
    expect(db.getEntitiesSince("asset", "uploaderKey", 0)).toHaveLength(1);
  });

  it("an asset with no referencing entity anywhere is invisible to everyone", () => {
    db.upsertEntity("board", { id: "b1", updated_at: 100, name: "B" }, "someKey");
    // No asset was ever pushed, so there's nothing to associate — sanity check
    // that referencing-scan doesn't invent associations out of thin air.
    expect(db.getEntitiesSince("asset", "someKey", 0)).toHaveLength(0);
  });
});

// ── schema_version migrations (§12.1) ─────────────────────────────────────────

describe("schema_version migrations", () => {
  it("stamps a schema_version on a fresh database", () => {
    const db = openDb(":memory:");
    expect(db.getSchemaVersion()).toBeGreaterThan(0);
  });

  it("baselines a pre-existing deployment that has no version row", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const db = openDb(path);
      expect(db.getSchemaVersion()).toBeGreaterThan(0);

      // user_keys column rename (migration 3) survived and is queryable
      // through the renamed-internals API.
      expect(db.getUserKeys("home1")).toEqual([{ key: "grp1", name: null }]);

      // Pre-existing board data is intact and reachable through the normal
      // read path.
      expect(db.getEntitiesSince("board", "sharedKey", 0)).toHaveLength(1);

      // asset_keys backfill (migration 2): the asset referenced from the
      // legacy board's format_string is now associated with the board's key,
      // even though it predates the join table entirely.
      expect(db.getEntitiesSince("asset", "sharedKey", 0)).toHaveLength(1);
      // The unreferenced asset is left orphaned rather than guessed at.
      const boardKeyAssets = db.getEntitiesSince("asset", "sharedKey", 0) as any[];
      expect(boardKeyAssets.map((a) => a.id)).toEqual(["legacyasset0000001"]);
    } finally {
      cleanup();
    }
  });

  it("reopening an already-migrated database is a no-op (idempotent)", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const first = openDb(path);
      const version = first.getSchemaVersion();
      first.close();

      const second = openDb(path);
      expect(second.getSchemaVersion()).toBe(version);
      // Data survives a second migration pass untouched.
      expect(second.getUserKeys("home1")).toEqual([{ key: "grp1", name: null }]);
    } finally {
      cleanup();
    }
  });
});
