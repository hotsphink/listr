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
  CREATE INDEX IF NOT EXISTS idx_boards ON boards(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_lists ON lists(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_items ON items(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at);
  CREATE INDEX IF NOT EXISTS idx_tombstones ON tombstones(sync_key, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results ON integration_results(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_integration_results_item ON integration_results(item_id);
  CREATE INDEX IF NOT EXISTS idx_integration_results_refresh ON integration_results(integration_id, status, updated_at);
`;

// Migrate existing databases that predate the extracted columns.
function applyMigrations(sql: Database.Database): void {
  function hasColumn(table: string, col: string): boolean {
    const cols = sql.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return cols.some((c) => c.name === col);
  }

  if (!hasColumn("boards", "created_at")) {
    sql.exec(`ALTER TABLE boards ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE boards SET created_at = json_extract(data, '$.created_at')`);
  }

  if (!hasColumn("lists", "board_id")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN board_id TEXT`);
    sql.exec(`UPDATE lists SET board_id = json_extract(data, '$.board_id')`);
    sql.exec(`DELETE FROM lists WHERE board_id IS NULL`);
  }
  if (!hasColumn("lists", "created_at")) {
    sql.exec(`ALTER TABLE lists ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE lists SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id)`);

  if (!hasColumn("items", "list_id")) {
    sql.exec(`ALTER TABLE items ADD COLUMN list_id TEXT`);
    sql.exec(`UPDATE items SET list_id = json_extract(data, '$.list_id')`);
  }
  if (!hasColumn("items", "created_at")) {
    sql.exec(`ALTER TABLE items ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE items SET created_at = json_extract(data, '$.created_at')`);
  }
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_items_list ON items(list_id)`);

  if (!hasColumn("assets", "created_at")) {
    sql.exec(`ALTER TABLE assets ADD COLUMN created_at INTEGER`);
    sql.exec(`UPDATE assets SET created_at = json_extract(data, '$.created_at')`);
  }
  if (hasColumn("assets", "sync_key")) {
    sql.exec(`CREATE TABLE assets_new (id TEXT PRIMARY KEY, created_at INTEGER, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`);
    sql.exec(`INSERT INTO assets_new SELECT id, created_at, updated_at, data FROM assets`);
    sql.exec(`DROP TABLE assets`);
    sql.exec(`ALTER TABLE assets_new RENAME TO assets`);
    sql.exec(`CREATE INDEX IF NOT EXISTS idx_assets ON assets(updated_at)`);
  }
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

    if (type === "asset") {
      sql
        .prepare(`INSERT INTO assets (id, created_at, updated_at, data) VALUES (?, ?, ?, ?)
                  ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, updated_at=excluded.updated_at, data=excluded.data`)
        .run(data.id, data.created_at ?? null, data.updated_at, JSON.stringify(data));
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
      .run(data.id, syncKey, data.updated_at, JSON.stringify(data), ...extraVals);
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
      const rows = sql
        .prepare(`SELECT data FROM ${table} WHERE updated_at > ?`)
        .all(since) as { data: string }[];
      return rows.map((r) => JSON.parse(r.data));
    }
    const rows = sql
      .prepare(`SELECT data FROM ${table} WHERE sync_key = ? AND updated_at > ?`)
      .all(syncKey, since) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  function applyTombstone(entityType: EntityType, entityId: string, deletedAt: number, syncKey: string): boolean {
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

  return {
    getServerId, upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince,
    getEntityById, upsertIntegrationResult, getIntegrationResultsSince, getIntegrationResultsForRefresh,
  };
}

export function openDb(path: string): ReturnType<typeof createDbApi> {
  const sql = new Database(path);
  sql.pragma("journal_mode = WAL");
  sql.exec(SCHEMA_SQL);
  applyMigrations(sql);
  return createDbApi(sql);
}

// Production module-level instance
const dataDir = config.db_path ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
export const db = openDb(join(dataDir, "listr.db"));
export const {
  getServerId,
  upsertEntity,
  getEntitiesSince,
  applyTombstone,
  getTombstonesSince,
  getEntityById,
  upsertIntegrationResult,
  getIntegrationResultsSince,
  getIntegrationResultsForRefresh,
} = db;
