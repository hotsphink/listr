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
    .run("b1", "sharedKey", 100, JSON.stringify({ id: "b1", sync_key: "sharedKey", updated_at: 100, name: "Legacy", format_string: "![img](hash://a1b2c3d4e5f60718293a.png)" }));
  raw.prepare(`INSERT INTO assets (id, updated_at, data) VALUES (?, ?, ?)`).run("a1b2c3d4e5f60718293a", 90, JSON.stringify(makeAsset("a1b2c3d4e5f60718293a", 90)));
  raw.prepare(`INSERT INTO assets (id, updated_at, data) VALUES (?, ?, ?)`).run("b2c3d4e5f60718293a4b", 80, JSON.stringify(makeAsset("b2c3d4e5f60718293a4b", 80)));
  raw.prepare(`INSERT INTO user_keys (user_key, key, name, added_at) VALUES (?, ?, ?, ?)`).run("home1", "grp1", null, 100);
  raw.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// -- upsertEntity: entity vs entity ------------------------------------------
describe("upsertEntity: entity vs entity LWW", () => {
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

// -- upsertEntity: item schema_version format gate ---------------------------
describe("upsertEntity: item format gate", () => {
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

  it("still gates only items; boards/lists are unaffected", () => {
    expect(db.upsertEntity("board", makeBoard("b1", 100), KEY).accepted).toBe(true);
    expect(db.upsertEntity("list", makeList("l1", 100), KEY).accepted).toBe(true);
  });
});

// -- upsertEntity: entity vs tombstone ---------------------------------------
describe("upsertEntity: entity vs tombstone LWW", () => {
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

// -- applyTombstone: tombstone vs tombstone ----------------------------------
describe("applyTombstone: tombstone vs tombstone LWW", () => {
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

// -- applyTombstone: tombstone vs entity (entity deletion) -------------------
describe("applyTombstone: entity deletion LWW", () => {
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
    db.upsertEntity("list", makeList("l1", 300), KEY);   // newer than tombstone, accepted
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
    // Old tombstone arriving again must not delete the newer entity
    db.applyTombstone("list", "l1", 200, KEY);           // rejected (existing tombstone same age)
    expect(db.getEntitiesSince("list", KEY, 0)).toHaveLength(1);
  });
});

// -- user_keys: server-side user/key-group association -----------------------
// Keyed by user_id, with a real FK to `users`. better-sqlite3 enforces
// foreign_keys by default, so every association here is created against an
// actual user rather than an arbitrary string standing in for one.

describe("user_keys", () => {
  let db: DbApi;
  let user1: string;
  let user2: string;
  beforeEach(() => {
    db = openDb(":memory:");
    user1 = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now()).user_id;
    user2 = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now()).user_id;
  });

  it("associates a key with a user and returns it via getUserKeys", () => {
    db.associateUserKey(user1, "group1", null);
    expect(db.getUserKeys(user1)).toEqual([{ key: "group1", name: null }]);
  });

  it("returns nothing for a user with no associations", () => {
    expect(db.getUserKeys(user1)).toEqual([]);
  });

  it("keeps associations for different users separate", () => {
    db.associateUserKey(user1, "group1", null);
    db.associateUserKey(user2, "group2", null);
    expect(db.getUserKeys(user1)).toEqual([{ key: "group1", name: null }]);
    expect(db.getUserKeys(user2)).toEqual([{ key: "group2", name: null }]);
  });

  it("re-associating with a name upgrades a previously unnamed key", () => {
    db.associateUserKey(user1, "group1", null);
    db.associateUserKey(user1, "group1", "Team Trip");
    expect(db.getUserKeys(user1)).toEqual([{ key: "group1", name: "Team Trip" }]);
  });

  it("re-associating with a null name does not clobber an existing name", () => {
    db.associateUserKey(user1, "group1", "Team Trip");
    db.associateUserKey(user1, "group1", null);
    expect(db.getUserKeys(user1)).toEqual([{ key: "group1", name: "Team Trip" }]);
  });

  it("removeUserKey drops the association", () => {
    db.associateUserKey(user1, "group1", "Team Trip");
    db.removeUserKey(user1, "group1");
    expect(db.getUserKeys(user1)).toEqual([]);
  });

  it("removeUserKey on a nonexistent association is a no-op", () => {
    expect(() => db.removeUserKey(user1, "group1")).not.toThrow();
  });

  it("rejects an association against a user_id that doesn't exist (FK enforced)", () => {
    expect(() => db.associateUserKey("no-such-user", "group1", null)).toThrow();
  });
});

describe("getOrCreateUserByHomeKey: home-key bridge", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("mints an unparented, non-provisional user with caps=['sync'] on first sight of a home key", () => {
    const user = db.getOrCreateUserByHomeKey("some-home-key");
    expect(user.home_key).toBe("some-home-key");
    expect(user.authorized_by).toBeNull();
    expect(user.provisional).toBe(false);
    expect(user.caps).toEqual(["sync"]);
  });

  it("is idempotent: the same home key resolves to the same user on a later call", () => {
    const first = db.getOrCreateUserByHomeKey("some-home-key");
    const second = db.getOrCreateUserByHomeKey("some-home-key");
    expect(second.user_id).toBe(first.user_id);
    expect(db.listAllUsers()).toHaveLength(1);
  });
});

// -- updated_at / deleted_at clamped to server time --------------------------
describe("upsertEntity: clamps updated_at to server time", () => {
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
    // back out of the JSON `data` blob. If clamping mutated one and not the
    // other, a future `since` query keyed on the real column value would not
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
    // skew window". It cannot reduce it to zero, since the clamped value is
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

describe("applyTombstone: clamps deleted_at to server time", () => {
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

// -- assets: per-key isolation via asset_keys --------------------------------
describe("assets: per-key isolation via asset_keys", () => {
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
    db.upsertEntity("asset", makeAsset("c3d4e5f60718293a4b5c", 100), "uploaderKey");
    db.upsertEntity(
      "board",
      { id: "b1", updated_at: 100, name: "B", format_string: "![img](hash://c3d4e5f60718293a4b5c.png)" },
      "sharedBoardKey",
    );
    expect(db.getEntitiesSince("asset", "sharedBoardKey", 0)).toHaveLength(1);
    // And the uploader's own key still sees it too: association is additive.
    expect(db.getEntitiesSince("asset", "uploaderKey", 0)).toHaveLength(1);
  });

  it("associates correctly when the entity is pushed BEFORE the asset", () => {
    // This is the order doInitialSync actually uses: boards, then lists, then
    // items, and only then assets. An implementation that scans the existing
    // assets table at entity-push time silently misses this case, leaving the
    // image visible only to the uploader.
    db.upsertEntity(
      "board",
      { id: "b1", updated_at: 100, name: "B", format_string: "![img](hash://d4e5f60718293a4b5c6d.png)" },
      "sharedBoardKey",
    );
    // Asset arrives afterwards, under the uploader's home key as always.
    db.upsertEntity("asset", makeAsset("d4e5f60718293a4b5c6d", 100), "uploaderKey");

    expect(db.getEntitiesSince("asset", "sharedBoardKey", 0)).toHaveLength(1);
    expect(db.getEntitiesSince("asset", "uploaderKey", 0)).toHaveLength(1);
    expect(db.getEntitiesSince("asset", "unrelatedKey", 0)).toHaveLength(0);
  });

  it("only matches well-formed hash:// references, not bare id substrings", () => {
    db.upsertEntity("asset", makeAsset("e5f60718293a4b5c6d7e", 100), "uploaderKey");
    // The id appears in the text but not as a hash:// reference, so it is not
    // a real reference and must not grant the board's key access to the asset.
    db.upsertEntity(
      "board",
      { id: "b1", updated_at: 100, name: "e5f60718293a4b5c6d7e is just a word here" },
      "someKey",
    );
    expect(db.getEntitiesSince("asset", "someKey", 0)).toHaveLength(0);
  });

  it("an asset with no referencing entity anywhere is invisible to everyone", () => {
    db.upsertEntity("board", { id: "b1", updated_at: 100, name: "B" }, "someKey");
    // No asset was ever pushed, so there is nothing to associate. This is a
    // sanity check that the referencing scan does not invent associations out
    // of thin air.
    expect(db.getEntitiesSince("asset", "someKey", 0)).toHaveLength(0);
  });
});

// -- schema_version migrations -----------------------------------------------
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

      // user_keys is keyed by user_id, so the association for "home1"
      // survives and is reachable via the user migration 5 mints for it.
      const user = db.getOrCreateUserByHomeKey("home1");
      expect(db.getUserKeys(user.user_id)).toEqual([{ key: "grp1", name: null }]);

      // Pre-existing board data is intact and reachable through the normal
      // read path.
      expect(db.getEntitiesSince("board", "sharedKey", 0)).toHaveLength(1);

      // asset_keys backfill (migration 2): the asset referenced from the
      // legacy board's format_string is now associated with the board's key,
      // even though it predates the join table entirely.
      expect(db.getEntitiesSince("asset", "sharedKey", 0)).toHaveLength(1);
      // The unreferenced asset is left orphaned rather than guessed at.
      const boardKeyAssets = db.getEntitiesSince("asset", "sharedKey", 0) as any[];
      expect(boardKeyAssets.map((a) => a.id)).toEqual(["a1b2c3d4e5f60718293a"]);
    } finally {
      cleanup();
    }
  });

  it("adds grants.payload_name to a database whose grants table predates it", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      // The legacy fixture's grants table is the one migration 4 creates,
      // which has no payload_name, so this only works if migration 6 ran.
      const db = openDb(path);
      const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now());
      const recipient = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now());
      const { grantId, secret } = db.createGrant(
        { kind: "share", issuerUserId: issuer.user_id, payload: "k", payloadName: "Team Trip" },
        Date.now(),
      );
      db.redeemGrant(grantId, secret, { existingUserId: recipient.user_id }, Date.now());
      expect(db.getUserKeys(recipient.user_id)).toEqual([{ key: "k", name: "Team Trip" }]);
    } finally {
      cleanup();
    }
  });

  it("converts legacy board and list formats without touching updated_at (migration 7)", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const raw = new Database(path);
      raw.prepare(`UPDATE boards SET data = ? WHERE id = 'b1'`).run(JSON.stringify({
        id: "b1", sync_key: "sharedKey", updated_at: 100, name: "Legacy", format_string: "{title}{m}", macros: { m: "!" },
      }));
      raw.prepare(`INSERT INTO lists (id, sync_key, updated_at, data) VALUES (?, ?, ?, ?)`).run(
        "l1", "sharedKey", 100, JSON.stringify({ id: "l1", board_id: "b1", updated_at: 100, name: "L", format_string: "{m}" }),
      );
      raw.close();

      const check = (db: DbApi) => {
        const [board] = db.getEntitiesSince("board", "sharedKey", 0) as any[];
        expect(board.format).toEqual({ version: 2, text: "[title][m]\n\nm=q( ! )" });
        expect(board).not.toHaveProperty("format_string");
        expect(board).not.toHaveProperty("macros");
        expect(board.updated_at).toBe(100);
        // A list override inherits the board's definitions, including its macros.
        const [list] = db.getEntitiesSince("list", "sharedKey", 0) as any[];
        expect(list.format).toEqual({ version: 2, text: "[m]" });
        expect(list.updated_at).toBe(100);
      };
      const db = openDb(path);
      check(db);
      db.close();
      check(openDb(path));
    } finally {
      cleanup();
    }
  });

  it("reopening an already-migrated database is a no-op (idempotent)", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const first = openDb(path);
      const version = first.getSchemaVersion();
      const mintedUserId = first.getOrCreateUserByHomeKey("home1").user_id;
      first.close();

      const second = openDb(path);
      expect(second.getSchemaVersion()).toBe(version);
      // Data survives a second migration pass untouched: same user, same
      // association, no double-mint.
      expect(second.getOrCreateUserByHomeKey("home1").user_id).toBe(mintedUserId);
      expect(second.getUserKeys(mintedUserId)).toEqual([{ key: "grp1", name: null }]);
    } finally {
      cleanup();
    }
  });

  it("migration 4 adds the identity tables and user_keys.access to a pre-v5 database", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const db = openDb(path);
      // Didn't exist at all pre-migration; a working createUser call is the
      // real assertion that the tables (and their columns) are usable.
      const user = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now());
      expect(user.user_id).toBeTruthy();
      // access column defaults to 'rw', including on rows migration 5 rekeyed
      // from the pre-existing "home1"/"grp1" association.
      const legacyUser = db.getOrCreateUserByHomeKey("home1");
      const raw = new Database(path);
      const row = raw.prepare(`SELECT access FROM user_keys WHERE user_id = ? AND key = 'grp1'`).get(legacyUser.user_id) as {
        access: string;
      };
      expect(row.access).toBe("rw");
      raw.close();
    } finally {
      cleanup();
    }
  });
});

// -- migration 5: user_keys rekeyed to user_id, legacy home keys minted ------
describe("migration 5: user_keys rekey and legacy user minting", () => {
  it("mints exactly one unparented, non-provisional, caps=['sync'] user per distinct pre-existing home key", () => {
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const db = openDb(path);
      const user = db.getOrCreateUserByHomeKey("home1"); // resolves the minted user, doesn't create a second one
      expect(user.home_key).toBe("home1");
      expect(user.authorized_by).toBeNull();
      expect(user.provisional).toBe(false);
      expect(user.caps).toEqual(["sync"]);
      expect(db.getUserKeys(user.user_id)).toEqual([{ key: "grp1", name: null }]);
      expect(db.listAllUsers()).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it("does not confuse a migration-minted legacy user with the designated root", () => {
    // Several unparented users make a structurally fine forest, but only one
    // of them is the root bootstrap-root created, so findRootUser must not
    // just grab whichever unparented row it finds first.
    const { path, cleanup } = makeLegacyDbFile();
    try {
      const db = openDb(path);
      const legacyUser = db.getOrCreateUserByHomeKey("home1"); // unparented, minted by migration 5
      expect(db.findRootUser()).toBeNull();

      const root = db.bootstrapRootUser(Date.now());
      expect(root.user_id).not.toBe(legacyUser.user_id);
      expect(db.findRootUser()?.user_id).toBe(root.user_id);
    } finally {
      cleanup();
    }
  });

  it("a fresh (never-legacy) database needs no minting and gets the plain user_id index", () => {
    const db = openDb(":memory:");
    expect(db.listAllUsers()).toHaveLength(0);
    const user = db.createUser({ authorizedBy: null, caps: ["sync"] }, Date.now());
    db.associateUserKey(user.user_id, "k", null);
    expect(db.getUserKeys(user.user_id)).toEqual([{ key: "k", name: null }]);
  });
});

// -- Identity & authorization ------------------------------------------------
describe("users: tree, effective state, cascade", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("bootstrapRootUser creates a root with all caps and is idempotent", () => {
    const root = db.bootstrapRootUser(Date.now());
    expect(root.authorized_by).toBeNull();
    expect(root.caps.sort()).toEqual(["admin", "invite", "moderate", "sync"]);
    const again = db.bootstrapRootUser(Date.now());
    expect(again.user_id).toBe(root.user_id);
    expect(db.listAllUsers()).toHaveLength(1);
  });

  it("computes effective state across a 3-deep tree via the recursive CTE", () => {
    const now = Date.now();
    const root = db.createUser({ authorizedBy: null, caps: ["sync", "invite", "admin"] }, now);
    const a = db.createUser({ authorizedBy: root.user_id, caps: ["sync", "invite"] }, now);
    const b = db.createUser({ authorizedBy: a.user_id, caps: ["sync", "invite"] }, now);
    const c = db.createUser({ authorizedBy: b.user_id, caps: ["sync"] }, now);

    // Everyone starts active.
    for (const u of [root, a, b, c]) expect(db.getEffectiveState(u.user_id)).toBe("active");

    // Suspending A (depth 1) is the worst state on the path for B and C
    // (depth 2 and 3), but not for root, which is above A.
    db.setUserState(a.user_id, "suspended", now);
    expect(db.getEffectiveState(root.user_id)).toBe("active");
    expect(db.getEffectiveState(a.user_id)).toBe("suspended");
    expect(db.getEffectiveState(b.user_id)).toBe("suspended");
    expect(db.getEffectiveState(c.user_id)).toBe("suspended");
  });

  it("cascade suspend is one UPDATE, and restore reverts descendants to their OWN explicit state", () => {
    const now = Date.now();
    const root = db.createUser({ authorizedBy: null, caps: ["sync", "invite", "admin"] }, now);
    const a = db.createUser({ authorizedBy: root.user_id, caps: ["sync", "invite"] }, now);
    const b = db.createUser({ authorizedBy: a.user_id, caps: ["sync"] }, now);
    const c = db.createUser({ authorizedBy: b.user_id, caps: ["sync"] }, now);

    // C is independently suspended by its own moderator, unrelated to A.
    db.setUserState(c.user_id, "suspended", now);
    // Now A gets cut off too, cascading to B and (already-suspended) C.
    db.setUserState(a.user_id, "suspended", now);
    expect(db.getEffectiveState(b.user_id)).toBe("suspended");
    expect(db.getEffectiveState(c.user_id)).toBe("suspended");

    // Restoring A is one UPDATE on A's row alone.
    db.setUserState(a.user_id, "active", now);
    expect(db.getEffectiveState(a.user_id)).toBe("active");
    // B has no explicit state of its own, so it reverts to active automatically.
    expect(db.getEffectiveState(b.user_id)).toBe("active");
    expect(db.getUser(b.user_id)?.state).toBe("active");
    // C's own explicit suspension survives A's restore untouched: the cascade
    // never writes C's row, and neither does restoring A.
    expect(db.getEffectiveState(c.user_id)).toBe("suspended");
    expect(db.getUser(c.user_id)?.state).toBe("suspended");
  });

  it("revoke is worse than suspend on the same path", () => {
    const now = Date.now();
    const root = db.createUser({ authorizedBy: null, caps: ["sync", "admin"] }, now);
    const a = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, now);
    db.setUserState(a.user_id, "suspended", now);
    db.setUserState(root.user_id, "revoked", now);
    // revoked (root) outranks suspended (a) as the worst state on the path.
    expect(db.getEffectiveState(a.user_id)).toBe("revoked");
  });

  it("depth-caps the walk defensively (does not hang on a very deep chain)", () => {
    const now = Date.now();
    let parent: string | null = null;
    let leaf = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    parent = leaf.user_id;
    for (let i = 0; i < 20; i++) {
      leaf = db.createUser({ authorizedBy: parent, caps: ["sync"] }, now);
      parent = leaf.user_id;
    }
    expect(db.getEffectiveState(leaf.user_id)).toBe("active");
  });
});

describe("grants: attenuation", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("rejects a grant whose caps exceed the issuer's own caps", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    expect(() => db.createGrant({ kind: "invite", issuerUserId: issuer.user_id, caps: ["moderate"] }, now)).toThrow();
  });

  it("allows a grant whose caps are a subset of the issuer's own caps", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite", "moderate"] }, now);
    expect(() => db.createGrant({ kind: "invite", issuerUserId: issuer.user_id, caps: ["invite"] }, now)).not.toThrow();
  });

  it("never allows admin via a grant, even from an admin issuer", () => {
    const now = Date.now();
    const root = db.bootstrapRootUser(now); // has admin
    expect(root.caps).toContain("admin");
    expect(() => db.createGrant({ kind: "invite", issuerUserId: root.user_id, caps: ["admin"] }, now)).toThrow(/admin/);
  });

  it("rejects issuing a grant from a non-active (effective) issuer", () => {
    const now = Date.now();
    const root = db.createUser({ authorizedBy: null, caps: ["sync", "invite", "admin"] }, now);
    const child = db.createUser({ authorizedBy: root.user_id, caps: ["sync", "invite"] }, now);
    db.setUserState(root.user_id, "suspended", now); // cascades to child
    expect(() => db.createGrant({ kind: "invite", issuerUserId: child.user_id, caps: [] }, now)).toThrow();
  });

  // A user without 'invite' requesting caps=[] would otherwise sail through
  // assertCapsAttenuated's subset check, since the empty set is a subset of
  // anything. 'invite' is itself the authority bit that must be checked, not
  // just a ceiling on what the new user receives.
  it("rejects an invite/guest grant from an issuer who lacks the 'invite' cap, even requesting caps=[]", () => {
    const now = Date.now();
    const syncOnly = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    expect(() => db.createGrant({ kind: "invite", issuerUserId: syncOnly.user_id, caps: [] }, now)).toThrow(/invite/);
    expect(() => db.createGrant({ kind: "guest", issuerUserId: syncOnly.user_id, payload: "k" }, now)).toThrow(/invite/);
  });

  it("allows device/share grants from an issuer with only 'sync'", () => {
    const now = Date.now();
    const syncOnly = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    expect(() => db.createGrant({ kind: "device", issuerUserId: syncOnly.user_id }, now)).not.toThrow();
    expect(() => db.createGrant({ kind: "share", issuerUserId: syncOnly.user_id, payload: "k" }, now)).not.toThrow();
  });
});

describe("grants: redemption", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("redeems a single-use grant exactly once under repeated (simulated-concurrent) attempts", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);

    // Two callers racing on the same grant+secret: only one may ever see
    // changes===1, because the WHERE clause (uses_remaining > 0) is
    // evaluated by SQLite as part of the same write, not against a
    // previously-read snapshot.
    const first = db.attemptRedeemGrant(grantId, secret, now);
    const second = db.attemptRedeemGrant(grantId, secret, now);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("used");
  });

  it("rejects redemption of an expired grant", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id, expiresAt: now + 1000 }, now);
    const result = db.attemptRedeemGrant(grantId, secret, now + 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  it("rejects a wrong secret without consuming the use", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);
    const wrong = db.attemptRedeemGrant(grantId, secret + "x", now);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("bad_secret");
    // The real secret still works afterwards.
    const right = db.attemptRedeemGrant(grantId, secret, now);
    expect(right.ok).toBe(true);
  });

  it("burns the grant after repeated failed attempts, even against the correct secret", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);

    for (let i = 0; i < 10; i++) {
      const attempt = db.attemptRedeemGrant(grantId, "wrong-secret", now);
      expect(attempt.ok).toBe(false);
    }
    // Burned, so even the real secret is refused.
    const result = db.attemptRedeemGrant(grantId, secret, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("burned");
  });

  it("redeemGrant(invite) creates a new child user and registers the client", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "invite", issuerUserId: issuer.user_id, caps: ["sync"] }, now);

    const outcome = db.redeemGrant(grantId, secret, { clientId: "client-1", pubkeyJwk: "{}", label: "phone" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.user.authorized_by).toBe(issuer.user_id);
    expect(outcome.result.user.caps).toEqual(["sync"]);
    expect(outcome.result.user.provisional).toBe(false);
    expect(outcome.result.client?.client_id).toBe("client-1");

    const looked = db.getUserForClient("client-1");
    expect(looked?.user.user_id).toBe(outcome.result.user.user_id);
    expect(looked?.effectiveState).toBe("active");
  });

  it("redeemGrant(device) attaches the client to the issuer's EXISTING user, no new user", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);

    const before = db.listAllUsers().length;
    const outcome = db.redeemGrant(grantId, secret, { clientId: "client-2", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.user.user_id).toBe(issuer.user_id);
    expect(db.listAllUsers().length).toBe(before); // no identity effect beyond the client
  });

  it("redeemGrant(share) hands over a sync key with no identity effect", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const recipient = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "share", issuerUserId: issuer.user_id, payload: "shopping-list-key" }, now);

    const before = db.listAllUsers().length;
    const outcome = db.redeemGrant(grantId, secret, { existingUserId: recipient.user_id }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.syncKey).toBe("shopping-list-key");
    expect(db.listAllUsers().length).toBe(before); // no new user, no new client
    expect(db.getUserKeys(recipient.user_id)).toEqual([{ key: "shopping-list-key", name: null }]);
  });

  it("carries payload_name through to user_keys, so a shared group arrives named", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const recipient = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const { grantId, secret } = db.createGrant(
      { kind: "share", issuerUserId: issuer.user_id, payload: "trip-key", payloadName: "Team Trip" },
      now,
    );

    const outcome = db.redeemGrant(grantId, secret, { existingUserId: recipient.user_id }, now);
    expect(outcome.ok).toBe(true);
    expect(db.getUserKeys(recipient.user_id)).toEqual([{ key: "trip-key", name: "Team Trip" }]);
  });

  it("names a guest's key too, since a guest link is how a group reaches someone with no account", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant(
      { kind: "guest", issuerUserId: issuer.user_id, payload: "trip-key", payloadName: "Team Trip" },
      now,
    );

    const outcome = db.redeemGrant(grantId, secret, { clientId: "guest-client", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(db.getUserKeys(outcome.result.user.user_id)).toEqual([{ key: "trip-key", name: "Team Trip" }]);
  });

  it("leaves the key unnamed when no payload_name is given, so an individual board share stays in the generic bucket", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const recipient = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const { grantId, secret } = db.createGrant(
      { kind: "share", issuerUserId: issuer.user_id, payload: "solo-board-key" },
      now,
    );

    db.redeemGrant(grantId, secret, { existingUserId: recipient.user_id }, now);
    expect(db.getUserKeys(recipient.user_id)).toEqual([{ key: "solo-board-key", name: null }]);
  });

  it("guest grants create a provisional user with caps=['sync'] only, with no invite cap, by construction", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    // Even if a caller tried to smuggle extra caps through, guest ignores
    // caller-supplied caps entirely: createGrant hardcodes ['sync'].
    const { grantId, secret } = db.createGrant(
      { kind: "guest", issuerUserId: issuer.user_id, payload: "shopping-list-key", greeting: "Dad's shopping list" },
      now,
    );

    const outcome = db.redeemGrant(grantId, secret, { clientId: "sons-phone", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.user.provisional).toBe(true);
    expect(outcome.result.user.caps).toEqual(["sync"]);
    expect(outcome.result.user.caps).not.toContain("invite");
    expect(outcome.result.syncKey).toBe("shopping-list-key");
    expect(db.getUserKeys(outcome.result.user.user_id)).toEqual([{ key: "shopping-list-key", name: null }]);
  });

  // An already-registered client redeeming a foreign invite/guest grant must
  // neither burn the single use nor leave an orphaned user row behind.
  // registerClient's ON CONFLICT never reassigns user_id, so without the guard
  // in redeemGrant the newly created user never gets a client attached.
  it("rejects invite redemption from a client that already has an identity, without consuming the grant or creating an orphan", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const alreadyUserId = db.createUser({ authorizedBy: null, caps: ["sync"] }, now).user_id;
    db.registerClient({ clientId: "already-registered-client", userId: alreadyUserId, pubkeyJwk: "{}" }, now);

    const { grantId, secret } = db.createGrant({ kind: "invite", issuerUserId: issuer.user_id, caps: ["sync"] }, now);
    const usersBefore = db.listAllUsers().length;

    const outcome = db.redeemGrant(grantId, secret, { clientId: "already-registered-client", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("already_registered");

    // No orphan user was created.
    expect(db.listAllUsers().length).toBe(usersBefore);
    // The identity was not hijacked: the client is still attached to its own user.
    expect(db.getUserForClient("already-registered-client")?.user.user_id).toBe(alreadyUserId);
    // The grant is NOT burned, so the intended recipient can still use it.
    const retry = db.redeemGrant(grantId, secret, { clientId: "fresh-client", pubkeyJwk: "{}" }, now);
    expect(retry.ok).toBe(true);
  });

  // A guest grant is what a board share issues, and the sender cannot know
  // whether the recipient already has an account here. One link has to work
  // either way, so guest degrades to the share effect rather than failing.
  it("hands a guest grant's key to a client that already has an identity, minting nobody", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const alreadyUserId = db.createUser({ authorizedBy: null, caps: ["sync"] }, now).user_id;
    db.registerClient({ clientId: "already-registered", userId: alreadyUserId, pubkeyJwk: "{}" }, now);
    const { grantId, secret } = db.createGrant(
      { kind: "guest", issuerUserId: issuer.user_id, payload: "k", payloadName: "Camping Trip" },
      now,
    );
    const usersBefore = db.listAllUsers().length;

    const outcome = db.redeemGrant(grantId, secret, { clientId: "already-registered", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The key landed on their existing account, and no second identity appeared.
    expect(outcome.result.user.user_id).toBe(alreadyUserId);
    expect(outcome.result.syncKey).toBe("k");
    expect(db.listAllUsers().length).toBe(usersBefore);
    expect(db.getUserKeys(alreadyUserId)).toEqual([{ key: "k", name: "Camping Trip" }]);
  });

  it("does not touch an existing redeemer's caps or provisional flag when a guest grant degrades", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const existing = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    db.registerClient({ clientId: "full-user-client", userId: existing.user_id, pubkeyJwk: "{}" }, now);
    const { grantId, secret } = db.createGrant({ kind: "guest", issuerUserId: issuer.user_id, payload: "k" }, now);

    db.redeemGrant(grantId, secret, { clientId: "full-user-client", pubkeyJwk: "{}" }, now);

    // Redeeming a guest link must not demote an account that already exists.
    const after = db.getUser(existing.user_id)!;
    expect(after.caps).toEqual(["sync", "invite"]);
    expect(after.provisional).toBe(existing.provisional);
  });

  it("still mints a guest account for a client the server has never seen", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "guest", issuerUserId: issuer.user_id, payload: "k" }, now);

    const outcome = db.redeemGrant(grantId, secret, { clientId: "brand-new-client", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.user.provisional).toBeTruthy();
    expect(outcome.result.user.caps).toEqual(["sync"]);
  });

  it("device/share redemption from an already-registered client stays legal", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const alreadyUserId = db.createUser({ authorizedBy: null, caps: ["sync"] }, now).user_id;
    db.registerClient({ clientId: "known-client", userId: alreadyUserId, pubkeyJwk: "{}" }, now);

    const deviceGrant = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);
    const deviceOutcome = db.redeemGrant(deviceGrant.grantId, deviceGrant.secret, { clientId: "known-client", pubkeyJwk: "{}" }, now);
    expect(deviceOutcome.ok).toBe(true);

    const shareGrant = db.createGrant({ kind: "share", issuerUserId: issuer.user_id, payload: "k" }, now);
    const shareOutcome = db.redeemGrant(shareGrant.grantId, shareGrant.secret, { existingUserId: alreadyUserId }, now);
    expect(shareOutcome.ok).toBe(true);
  });

  it("promote clears provisional and can add caps, without re-creating the user", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "guest", issuerUserId: issuer.user_id, payload: "k" }, now);
    const outcome = db.redeemGrant(grantId, secret, { clientId: "c", pubkeyJwk: "{}" }, now);
    if (!outcome.ok) throw new Error("setup failed");
    const guestId = outcome.result.user.user_id;
    const homeKeyBefore = outcome.result.user.home_key;

    const promoted = db.promoteProvisionalUser(guestId, ["invite"], now);
    expect(promoted.provisional).toBe(false);
    expect(promoted.caps.sort()).toEqual(["invite", "sync"]);
    expect(promoted.user_id).toBe(guestId);
    expect(promoted.home_key).toBe(homeKeyBefore); // same identity, not re-created
  });
});

describe("peekGrant: read-only preview", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("reveals the greeting and issuer's display name without consuming a use", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"], displayName: "Steve" }, now);
    const { grantId, secret } = db.createGrant(
      { kind: "guest", issuerUserId: issuer.user_id, payload: "k", greeting: "Dad's shopping list" },
      now,
    );

    const peek = db.peekGrant(grantId, secret, now);
    expect(peek.ok).toBe(true);
    if (!peek.ok) return;
    expect(peek.grant.greeting).toBe("Dad's shopping list");
    expect(peek.issuerDisplayName).toBe("Steve");

    // Still fully redeemable afterward, since peek never touches uses_remaining.
    const outcome = db.redeemGrant(grantId, secret, { clientId: "c", pubkeyJwk: "{}" }, now);
    expect(outcome.ok).toBe(true);
  });

  it("shares the same attempt budget as attemptRedeemGrant, so it cannot be used as a free brute-force oracle", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "guest", issuerUserId: issuer.user_id, payload: "k" }, now);

    for (let i = 0; i < 10; i++) {
      const attempt = db.peekGrant(grantId, "wrong", now);
      expect(attempt.ok).toBe(false);
    }
    // Burned, so even the real secret is refused, via peek or redemption.
    const peek = db.peekGrant(grantId, secret, now);
    expect(peek.ok).toBe(false);
    if (!peek.ok) expect(peek.reason).toBe("burned");
    const redeem = db.attemptRedeemGrant(grantId, secret, now);
    expect(redeem.ok).toBe(false);
  });
});

describe("clients", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("getClientsForUser lists only that user's own clients", () => {
    const now = Date.now();
    const alice = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    const bob = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    db.registerClient({ clientId: "alice-phone", userId: alice.user_id, pubkeyJwk: "{}", label: "phone" }, now);
    db.registerClient({ clientId: "alice-laptop", userId: alice.user_id, pubkeyJwk: "{}" }, now);
    db.registerClient({ clientId: "bobs-tablet", userId: bob.user_id, pubkeyJwk: "{}" }, now);

    const aliceClients = db.getClientsForUser(alice.user_id).map((c) => c.client_id).sort();
    expect(aliceClients).toEqual(["alice-laptop", "alice-phone"]);
  });

  it("getUserForClient returns the user's effective state, reflecting a cascaded suspension", () => {
    const now = Date.now();
    const root = db.createUser({ authorizedBy: null, caps: ["sync", "invite", "admin"] }, now);
    const child = db.createUser({ authorizedBy: root.user_id, caps: ["sync"] }, now);
    db.registerClient({ clientId: "device-x", userId: child.user_id, pubkeyJwk: "{}" }, now);

    expect(db.getUserForClient("device-x")?.effectiveState).toBe("active");
    db.setUserState(root.user_id, "suspended", now);
    expect(db.getUserForClient("device-x")?.effectiveState).toBe("suspended");
  });

  it("returns null for an unknown client_id", () => {
    expect(db.getUserForClient("nonexistent")).toBeNull();
  });
});

describe("users: self-set display name", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("sets and reads back a user's own display_name", () => {
    const now = Date.now();
    const user = db.createUser({ authorizedBy: null, caps: ["sync"] }, now);
    expect(user.display_name).toBeNull();
    const updated = db.setUserDisplayName(user.user_id, "Steve", now);
    expect(updated.display_name).toBe("Steve");
    expect(db.getUser(user.user_id)?.display_name).toBe("Steve");
  });
});

describe("auth_events: append-only audit", () => {
  let db: DbApi;
  beforeEach(() => { db = openDb(":memory:"); });

  it("logs grant issuance, redemption, and state changes", () => {
    const now = Date.now();
    const issuer = db.createUser({ authorizedBy: null, caps: ["sync", "invite"] }, now);
    const { grantId, secret } = db.createGrant({ kind: "device", issuerUserId: issuer.user_id }, now);
    db.redeemGrant(grantId, secret, { clientId: "c", pubkeyJwk: "{}" }, now);
    db.setUserState(issuer.user_id, "suspended", now);

    const kinds = db.listAuthEvents().map((e) => e.kind);
    expect(kinds).toContain("grant_issued_device");
    expect(kinds).toContain("grant_redeemed");
    expect(kinds).toContain("grant_effect_device");
    expect(kinds).toContain("state_set_suspended");
  });
});

describe("reset-server-id", () => {
  it("overwrites server_id and getServerId reflects it", () => {
    const db = openDb(":memory:");
    const before = db.getServerId();
    const after = db.resetServerId();
    expect(after).not.toBe(before);
    expect(db.getServerId()).toBe(after);

    const fixed = db.resetServerId("my-fixed-id");
    expect(fixed).toBe("my-fixed-id");
    expect(db.getServerId()).toBe("my-fixed-id");
  });
});

// -- re-keying an entity into a new namespace --------------------------------
//
// Sharing a board that had no sync_key assigns one, which bumps only the
// BOARD's updated_at. Its lists and items are untouched, so they re-push
// carrying their original timestamps. The LWW guard has to let those move
// namespace anyway, or the recipient subscribes to the new key and receives an
// empty board while every later addition lands somewhere they cannot see.
describe("re-keying an entity into a different namespace", () => {
  const OLD = "home-key";
  const NEW = "shared-key";
  let db: DbApi;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("moves a list whose updated_at has not changed", () => {
    db.upsertEntity("list", makeList("l1", 100), OLD);
    expect(db.getEntitiesSince("list", OLD, 0)).toHaveLength(1);

    db.upsertEntity("list", makeList("l1", 100), NEW);

    expect(db.getEntitiesSince("list", NEW, 0)).toHaveLength(1);
    expect(db.getEntitiesSince("list", OLD, 0)).toHaveLength(0);
  });

  it("moves an item whose updated_at has not changed", () => {
    db.upsertEntity("item", makeItem("i1", 100), OLD);
    db.upsertEntity("item", makeItem("i1", 100), NEW);

    expect(db.getEntitiesSince("item", NEW, 0)).toHaveLength(1);
    expect(db.getEntitiesSince("item", OLD, 0)).toHaveLength(0);
  });

  it("keeps the newer stored content when a stale re-key arrives", () => {
    db.upsertEntity("list", { ...makeList("l1", 200), name: "Current" }, OLD);
    db.upsertEntity("list", { ...makeList("l1", 100), name: "Stale" }, NEW);

    // The move happens, but the stale push must not overwrite the newer name.
    const rows = db.getEntitiesSince("list", NEW, 0) as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Current");
    expect(rows[0].updated_at).toBe(200);
  });

  it("associates an asset with the new namespace without unsharing the old one", () => {
    db.upsertEntity("asset", makeAsset("a1", 100), OLD);
    db.upsertEntity("asset", makeAsset("a1", 100), NEW);

    // Assets are many-to-many with namespaces, so both keep access.
    expect(db.getEntitiesSince("asset", NEW, 0)).toHaveLength(1);
    expect(db.getEntitiesSince("asset", OLD, 0)).toHaveLength(1);
  });

  it("still rejects a stale push that is not a re-key, so LWW is unchanged", () => {
    db.upsertEntity("list", { ...makeList("l1", 200), name: "Current" }, OLD);
    const outcome = db.upsertEntity("list", { ...makeList("l1", 100), name: "Stale" }, OLD);

    expect(outcome.accepted).toBe(false);
    const rows = db.getEntitiesSince("list", OLD, 0) as any[];
    expect(rows[0].name).toBe("Current");
  });
});

// The orphaned-data question after an identity rebuild: a key can hold plenty
// of rows and still be unreachable, because a client only ever pulls keys it
// already knows about, and it learns them from ok.user_keys.
describe("listSyncKeysWithData", () => {
  let db: DbApi;

  beforeEach(() => {
    db = openDb(":memory:");
  });

  it("counts rows per key and reports a key no user can reach as unclaimed", () => {
    db.upsertEntity("board", makeBoard("b1", 100), "orphan");
    db.upsertEntity("list", makeList("l1", 100), "orphan");
    db.upsertEntity("item", makeItem("i1", 100), "orphan");
    db.upsertEntity("item", makeItem("i2", 100), "orphan");

    const keys = db.listSyncKeysWithData();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ key: "orphan", boards: 1, lists: 1, items: 2, users: [] });
  });

  it("counts both an explicit association and a home key as a claim", () => {
    const root = db.bootstrapRootUser(Date.now());
    db.upsertEntity("board", makeBoard("b1", 100), "shared");
    db.upsertEntity("board", makeBoard("b2", 100), root.home_key);
    db.associateUserKey(root.user_id, "shared", "Shared");

    const byKey = new Map(db.listSyncKeysWithData().map((k) => [k.key, k.users]));
    expect(byKey.get("shared")).toEqual([root.user_id]);
    expect(byKey.get(root.home_key)).toEqual([root.user_id]);
  });

  it("ignores a key that is associated but holds no data", () => {
    const root = db.bootstrapRootUser(Date.now());
    db.associateUserKey(root.user_id, "empty", null);
    expect(db.listSyncKeysWithData()).toEqual([]);
  });
});
