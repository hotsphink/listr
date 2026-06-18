import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
const dataDir = join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });
const sql = new Database(join(dataDir, "listr.db"));
sql.pragma("journal_mode = WAL");
sql.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lists (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    sync_key TEXT NOT NULL,
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
  CREATE INDEX IF NOT EXISTS idx_categories ON categories(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_lists ON lists(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_items ON items(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_assets ON assets(sync_key, updated_at);
  CREATE INDEX IF NOT EXISTS idx_tombstones ON tombstones(sync_key, deleted_at);
`);
function tableFor(type) {
    if (type === "category")
        return "categories";
    if (type === "list")
        return "lists";
    if (type === "asset")
        return "assets";
    return "items";
}
export function upsertEntity(type, data, syncKey) {
    const table = tableFor(type);
    const existing = sql
        .prepare(`SELECT updated_at FROM ${table} WHERE id = ?`)
        .get(data.id);
    if (existing && existing.updated_at >= data.updated_at)
        return false;
    sql
        .prepare(`INSERT INTO ${table} (id, sync_key, updated_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sync_key=excluded.sync_key, updated_at=excluded.updated_at, data=excluded.data`)
        .run(data.id, syncKey, data.updated_at, JSON.stringify(data));
    return true;
}
export function getEntitiesSince(type, syncKey, since) {
    const table = tableFor(type);
    const rows = sql
        .prepare(`SELECT data FROM ${table} WHERE sync_key = ? AND updated_at > ?`)
        .all(syncKey, since);
    return rows.map((r) => JSON.parse(r.data));
}
export function applyTombstone(entityType, entityId, deletedAt, syncKey) {
    const existing = sql
        .prepare(`SELECT deleted_at FROM tombstones WHERE entity_id = ? AND entity_type = ?`)
        .get(entityId, entityType);
    if (existing && existing.deleted_at >= deletedAt)
        return false;
    sql
        .prepare(`INSERT INTO tombstones (id, sync_key, entity_type, entity_id, deleted_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET deleted_at=excluded.deleted_at`)
        .run(`${entityType}:${entityId}`, syncKey, entityType, entityId, deletedAt);
    sql.prepare(`DELETE FROM ${tableFor(entityType)} WHERE id = ?`).run(entityId);
    return true;
}
export function getTombstonesSince(syncKey, since) {
    return sql
        .prepare(`SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE sync_key = ? AND deleted_at > ?`)
        .all(syncKey, since);
}
