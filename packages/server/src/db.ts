import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isCurrentSchemaVersion } from "@listr/shared";
import type { IntegrationResult } from "@listr/shared";
import { config } from "./config.js";

export type EntityType = "board" | "list" | "item" | "asset";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    board_id TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    list_id TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    created_at INTEGER,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tombstones (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    deleted_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_results (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    item_id TEXT NOT NULL,
    integration_id TEXT NOT NULL,
    status TEXT NOT NULL,
    attribute_values TEXT,
    integration_data TEXT,
    error TEXT,
    created_at INTEGER,
    updated_at INTEGER NOT NULL
  );
  -- Column is \`home_key\` (renamed from \`user_key\`, see migration 3 below —
  -- internal rename only; the wire field \`hello.default_key\` is unrelated and
  -- unaffected, that rename rides the v5 protocol flag day).
  CREATE TABLE IF NOT EXISTS user_keys (
    home_key TEXT NOT NULL,
    key TEXT NOT NULL,
    name TEXT,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (home_key, key)
  );
  -- Many-to-many: the same content-addressed asset (Asset.id is a content
  -- hash) can legitimately be pushed into more than one namespace — e.g. the
  -- same image used on two unrelated boards. A single sync_key column on
  -- \`assets\` would be first-writer-wins and silently break the other
  -- namespace, so association lives in this join table instead. See
  -- migration 2.
  CREATE TABLE IF NOT EXISTS asset_keys (
    asset_id TEXT NOT NULL,
    sync_key TEXT NOT NULL,
    PRIMARY KEY (asset_id, sync_key)
  );
  CREATE INDEX IF NOT EXISTS idx_boards ON boards(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_lists ON lists(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_items ON items(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at);
  CREATE INDEX IF NOT EXISTS idx_tombstones ON tombstones(sync_key, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results ON integration_results(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results_item ON integration_results(item_id);
  CREATE INDEX IF NOT EXISTS idx_integration_results_refresh ON integration_results(integration_id, status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_asset_keys_key ON asset_keys(sync_key);
`;
// idx_user_keys is created in migration 3 below, not here — it indexes
// `home_key`, which only exists once that migration has run (SCHEMA_SQL above
// always runs first, and on a pre-existing database the column is still named
// `user_key` at that point).

// ── Schema versioning (§12.1) ────────────────────────────────────────────────
// A `schema_version` row in `server_config`, plus an ordered migration list
// that `applyMigrations` walks. Every migration body is written to be a no-op
// when its target shape already exists (same `hasColumn`-style guards the old
// ad-hoc code used), so a brand-new database — where SCHEMA_SQL above already
// creates the latest shape — and a pre-existing database that predates
// schema_version entirely (no row at all, treated as version 0) take the
// exact same path: baselining and upgrading are the same code.

function readSchemaVersion(sql: Database.Database): number {
  const row = sql.prepare(`SELECT value FROM server_config WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

function setSchemaVersion(sql: Database.Database, version: number): void {
  sql
    .prepare(
      `INSERT INTO server_config (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(version));
}

function hasColumn(sql: Database.Database, table: string, col: string): boolean {
  const cols = sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

// Migration 1: the columns that used to be added ad hoc via PRAGMA table_info
// inspection on every server start. Folded into the migration list unchanged
// (same idempotent hasColumn guards) so it becomes one versioned step instead
// of code that ran unconditionally on every boot.
function migrateV1LegacyColumnBaseline(sql: Database.Database): void {
  if (!hasColumn(sql, "boards", "created_at")) {
    sql.exec(`ALTER TABLE boards ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE boards SET created_at = json_extract(data, '$.created_at')`);
  }

  if (!hasColumn(sql, "lists", "board_id")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN board_id TEXT`);
    sql.exec(`UPDATE lists SET board_id = json_extract(data, '$.board_id')`);
    sql.exec(`DELETE FROM lists WHERE board_id IS NULL`);
  }
  if (!hasColumn(sql, "lists", "created_at")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE lists SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id)`);

  if (!hasColumn(sql, "items", "list_id")) {
    sql.exec(`ALTER TABLE items ADD COLUMN list_id TEXT`);
    sql.exec(`UPDATE items SET list_id = json_extract(data, '$.list_id')`);
  }
  if (!hasColumn(sql, "items", "created_at")) {
    sql.exec(`ALTER TABLE items ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE items SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id)`);

  if (!hasColumn(sql, "assets", "created_at")) {
    sql.exec(`ALTER TABLE assets ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE assets SET created_at = json_extract(data, '$.created_at')`);
  }
  if (hasColumn(sql, "assets", "sync_key")) {
    sql.exec(`CREATE TABLE assets_new (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`INSERT INTO assets_new SELECT id, created_at, updated_at, data FROM assets`);
    sql.exec(`DROP TABLE assets`);
    sql.exec(`ALTER TABLE assets_new RENAME TO assets`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at)`);
  }
}

// Migration 2: the asset_keys join table that closes the global asset leak
// (§2.1 defect 2) plus a one-time backfill for assets that predate it.
// Existing assets have no recorded association; leaving them unassociated
// would make them vanish for everyone, breaking images already in use.
// Backfill by substring-matching each asset id against every board/list/item's
// stored data — ids are 20 hex chars, so collisions aren't a practical
// concern, and these databases are small enough that an O(assets × entities)
// scan is fine. Assets matching nothing are genuinely orphaned; they're left
// unassociated and counted in the log line below.
function migrateV2AssetKeys(sql: Database.Database): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS asset_keys (asset_id TEXT NOT NULL, sync_key TEXT NOT NULL, PRIMARY KEY (asset_id, sync_key))`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_asset_keys_key ON asset_keys(sync_key)`);

  const assets = sql.prepare(`SELECT id FROM assets`).all() as { id: string }[];
  if (assets.length === 0) return;
  const insert = sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`);
  let matched = 0;
  for (const { id } of assets) {
    let hit = false;
    for (const table of ["boards", "lists", "items"] as const) {
      const rows = sql.prepare(`SELECT DISTINCT sync_key FROM ${table} WHERE data LIKE ?`).all(`%${id}%`) as { sync_key: string }[];
      for (const { sync_key } of rows) {
        insert.run(id, sync_key);
        hit = true;
      }
    }
    if (hit) matched++;
  }
  console.log(`[migrate] asset_keys backfill: associated ${matched}/${assets.length} asset(s), ${assets.length - matched} left orphaned (no referencing entity found)`);
}

// Migration 3: user_keys.user_key -> home_key (§12.1 — internal rename only;
// the wire field hello.default_key is unaffected and rides the v5 flag day).
function migrateV3RenameHomeKey(sql: Database.Database): void {
  if (hasColumn(sql, "user_keys", "user_key")) {
    sql.exec(`ALTER TABLE user_keys RENAME COLUMN user_key TO home_key`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_user_keys ON user_keys(home_key)`);
}

const MIGRATIONS: { version: number; run: (sql: Database.Database) => void }[] = [
  { version: 1, run: migrateV1LegacyColumnBaseline },
  { version: 2, run: migrateV2AssetKeys },
  { version: 3, run: migrateV3RenameHomeKey },
];

function applyMigrations(sql: Database.Database): void {
  const current = readSchemaVersion(sql);
  for (const { version, run } of MIGRATIONS) {
    if (version > current) {
      run(sql);
      setSchemaVersion(sql, version);
    }
  }
}

// ── Clock-skew clamp (§11.2.2) ──────────────────────────────────────────────
// A bad or malicious client clock can otherwise write updated_at/deleted_at
// far in the future; LWW then treats that version as permanently unbeatable —
// every honest later edit loses forever, on every device. Clamp (don't
// reject) to server time plus a small allowance, so an honestly-skewed clock
// still gets its write accepted.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function clampToServerTime(ts: number): number {
  const cap = Date.now() + MAX_CLOCK_SKEW_MS;
  return ts > cap ? cap : ts;
}

function tableFor(type: EntityType): string {
  if (type === "board") return "boards";
  if (type === "list") return "lists";
  if (type === "asset") return "assets";
  return "items";
}

export function createDbApi(sql: Database.Database) {
  function getServerId(): string {
    const row = sql.prepare("SELECT value FROM server_config WHERE key = 'server_id'").get() as { value: string } | undefined;
    if (row) return row.value;
    const id = randomUUID();
    sql.prepare("INSERT INTO server_config (key, value) VALUES ('server_id', ?)").run(id);
    return id;
  }

  // Any asset id (from the `assets` table) that appears as a substring of
  // `dataJson` gets linked to `syncKey`. Same technique as the migration-2
  // backfill above, run incrementally on every board/list/item push instead
  // of once. This matters going forward, not just for old data: a freshly
  // uploaded image is always pushed under the *uploader's* own key (the
  // client has no board context at asset-push time — see SyncClient
  // effectiveKeyForEntity), so without this, a new image added to a shared
  // board would sync down for its uploader only, not the people it was
  // shared with.
  function associateReferencedAssets(dataJson: string, syncKey: string): void {
    const assetIds = sql.prepare(`SELECT id FROM assets`).all() as { id: string }[];
    if (assetIds.length === 0) return;
    const insert = sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`);
    for (const { id } of assetIds) {
      if (dataJson.includes(id)) insert.run(id, syncKey);
    }
  }

  function upsertEntity(
    type: EntityType,
    data: Record<string, unknown>,
    syncKey: string,
  ): { accepted: boolean; previous: unknown | null } {
    // Format gate: refuse legacy/unversioned item blobs. The protocol version
    // gates the client BINARY, but a current client can still carry old-format
    // rows (the Dexie upgrade never touches sync-pulled data) and re-push them
    // in its initial sync. Keyed on schema_version alone — never field-sniffing.
    // Clients heal such rows to the current shape before their pushes are kept.
    if (type === "item" && !isCurrentSchemaVersion(data.schema_version)) {
      console.warn(`[sync] rejected legacy item ${data.id} (schema_version=${data.schema_version ?? "missing"})`);
      return { accepted: false, previous: null };
    }

    // Clamp before anything else touches it, so the stored column and the
    // embedded JSON (JSON.stringify(data) below) always agree.
    if (typeof data.updated_at === "number") {
      data.updated_at = clampToServerTime(data.updated_at);
    }

    const table = tableFor(type);
    const existingRow = sql
      .prepare(`SELECT updated_at, data FROM ${table} WHERE id = ?`)
      .get(data.id as string) as { updated_at: number; data: string } | undefined;
    if (existingRow && existingRow.updated_at >= (data.updated_at as number)) return { accepted: false, previous: null };
    // Reject if a newer tombstone already exists for this entity (tombstone wins on LWW).
    const tomb = sql
      .prepare(`SELECT deleted_at FROM tombstones WHERE entity_id = ? AND entity_type = ?`)
      .get(data.id as string, type) as { deleted_at: number } | undefined;
    if (tomb && tomb.deleted_at >= (data.updated_at as number)) return { accepted: false, previous: null };

    const previous = existingRow ? JSON.parse(existingRow.data) : null;
    const dataJson = JSON.stringify(data);

    if (type === "asset") {
      sql
        .prepare(`INSERT INTO assets (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, updated_at=excluded.updated_at, data=excluded.data`)
        .run(data.id, data.created_at ?? null, data.updated_at, dataJson);
      // Global leak fix (§2.1 defect 2): record which namespace pushed this
      // asset instead of it being visible to every namespace on the server.
      if (syncKey) {
        sql.prepare(`INSERT OR IGNORE INTO asset_keys (asset_id, sync_key) VALUES (?, ?)`).run(data.id, syncKey);
      }
      return { accepted: true, previous };
    }

    const extraCols: string[] = ["created_at"];
    const extraVals: unknown[] = [data.created_at ?? null];
    if (type === "list") { extraCols.push("board_id"); extraVals.push(data.board_id ?? null); }
    if (type === "item") { extraCols.push("list_id"); extraVals.push(data.list_id ?? null); }

    const baseCols = ["id", "sync_key", "updated_at", "data"];
    const allCols = [...baseCols, ...extraCols];
    const placeholders = allCols.map(() => "?").join(", ");
    const onConflict = ["sync_key", "updated_at", "data", ...extraCols].map((c) => `${c}=excluded.${c}`).join(", ");

    sql
      .prepare(`INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${onConflict}`)
      .run(data.id, syncKey, data.updated_at, dataJson, ...extraVals);
    associateReferencedAssets(dataJson, syncKey);
    return { accepted: true, previous };
  }

  function getEntityById(type: EntityType, id: string): unknown | null {
    const table = tableFor(type);
    const row = sql.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : null;
  }

  function upsertIntegrationResult(result: IntegrationResult): boolean {
    const existing = sql
      .prepare(`SELECT updated_at FROM integration_results WHERE id = ?`)
      .get(result.id) as { updated_at: number } | undefined;
    if (existing && existing.updated_at >= result.updated_at) return false;
    sql
      .prepare(`INSERT INTO integration_results
          (id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sync_key=excluded.sync_key, status=excluded.status,
            attribute_values=excluded.attribute_values, integration_data=excluded.integration_data,
            error=excluded.error, updated_at=excluded.updated_at`)
      .run(
        result.id, result.sync_key, result.item_id, result.integration_id,
        result.status, JSON.stringify(result.attribute_values),
        JSON.stringify(result.integration_data), result.error ?? null,
        result.created_at, result.updated_at,
      );
    return true;
  }

  function getIntegrationResultsSince(syncKey: string, since: number): IntegrationResult[] {
    const rows = sql
      .prepare(`SELECT id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at
                FROM integration_results WHERE sync_key = ? AND updated_at > ?`)
      .all(syncKey, since) as any[];
    return rows.map(rowToIntegrationResult);
  }

  function getIntegrationResultsForRefresh(integrationId: string, olderThan: number): IntegrationResult[] {
    const rows = sql
      .prepare(`SELECT id, sync_key, item_id, integration_id, status, attribute_values, integration_data, error, created_at, updated_at
                FROM integration_results WHERE integration_id = ? AND status = 'complete' AND updated_at < ?`)
      .all(integrationId, olderThan) as any[];
    return rows.map(rowToIntegrationResult);
  }

  function rowToIntegrationResult(row: any): IntegrationResult {
    return {
      id: row.id,
      sync_key: row.sync_key,
      item_id: row.item_id,
      integration_id: row.integration_id,
      status: row.status,
      attribute_values: JSON.parse(row.attribute_values ?? "{}"),
      integration_data: JSON.parse(row.integration_data ?? "{}"),
      error: row.error ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  function getEntitiesSince(type: EntityType, syncKey: string, since: number): unknown[] {
    const table = tableFor(type);
    if (type === "asset") {
      // Joined through asset_keys instead of a plain sync_key column — see
      // the asset_keys comment on SCHEMA_SQL above (§2.1 defect 2 fix).
      const rows = sql
        .prepare(`SELECT a.data FROM assets a JOIN asset_keys ak ON ak.asset_id = a.id WHERE ak.sync_key = ? AND a.updated_at > ?`)
        .all(syncKey, since) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data));
    }
    const rows = sql
      .prepare(`SELECT data FROM ${table} WHERE sync_key = ? AND updated_at > ?`)
      .all(syncKey, since) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  function applyTombstone(entityType: EntityType, entityId: string, deletedAt: number, syncKey: string): boolean {
    deletedAt = clampToServerTime(deletedAt);
    const existing = sql
      .prepare(`SELECT deleted_at FROM tombstones WHERE entity_id = ? AND entity_type = ?`)
      .get(entityId, entityType) as { deleted_at: number } | undefined;
    if (existing && existing.deleted_at >= deletedAt) return false;
    sql
      .prepare(
        `INSERT INTO tombstones (id, sync_key, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at`,
      )
      .run(`${entityType}:${entityId}`, syncKey, entityType, entityId, deletedAt);
    // Only delete the entity if it hasn't been updated more recently than the tombstone.
    sql.prepare(`DELETE FROM ${tableFor(entityType)} WHERE id = ? AND updated_at <= ?`).run(entityId, deletedAt);
    return true;
  }

  function getTombstonesSince(
    syncKey: string,
    since: number,
  ): { entity_type: string; entity_id: string; deleted_at: number }[] {
    return sql
      .prepare(`SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE sync_key = ? AND deleted_at > ?`)
      .all(syncKey, since) as { entity_type: string; entity_id: string; deleted_at: number }[];
  }

  // ── User/key-group associations (stopgap ahead of real user accounts) ──────
  // `homeKey` is a client's home sync_key (the wire field is still named
  // `default_key` — see protocol.ts v4/v5 — but internally this was renamed
  // per §12.1). `key` is never the home key itself.

  function associateUserKey(homeKey: string, key: string, name: string | null): void {
    sql
      .prepare(
        `INSERT INTO user_keys (home_key, key, name, added_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(home_key, key) DO UPDATE SET name = COALESCE(excluded.name, user_keys.name)`,
      )
      .run(homeKey, key, name, Date.now());
  }

  function removeUserKey(homeKey: string, key: string): void {
    sql.prepare(`DELETE FROM user_keys WHERE home_key = ? AND key = ?`).run(homeKey, key);
  }

  function getUserKeys(homeKey: string): { key: string; name: string | null }[] {
    return sql
      .prepare(`SELECT key, name FROM user_keys WHERE home_key = ?`)
      .all(homeKey) as { key: string; name: string | null }[];
  }

  function getSchemaVersionApi(): number {
    return readSchemaVersion(sql);
  }

  function close(): void {
    sql.close();
  }

  return {
    getServerId, upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince,
    getEntityById, upsertIntegrationResult, getIntegrationResultsSince, getIntegrationResultsForRefresh,
    associateUserKey, removeUserKey, getUserKeys, getSchemaVersion: getSchemaVersionApi, close,
  };
}

export function openDb(path: string): ReturnType<typeof createDbApi> {
  const sql = new Database(path);
  sql.pragma("journal_mode = WAL");
  sql.exec(SCHEMA_SQL);
  applyMigrations(sql);
  return createDbApi(sql);
}

// Production module-level instance — created lazily on first call rather than
// at import time. This module is imported by test files (for `openDb`) and by
// integration-runner.ts (type-only), and eager creation used to mean every
// such import opened the real on-disk database as a side effect — harmless
// against the disposable in-repo data/listr.db, but a real hazard against a
// deployment whose config.db_path points at the actual (sandboxed read-only)
// production database. Only index.ts's production entry point calls this.
let productionDb: ReturnType<typeof createDbApi> | null = null;

export function getProductionDb(): ReturnType<typeof createDbApi> {
  if (!productionDb) {
    const dataDir = config.db_path ?? join(process.cwd(), "data");
    mkdirSync(dataDir, { recursive: true });
    productionDb = openDb(join(dataDir, "listr.db"));
  }
  return productionDb;
}
