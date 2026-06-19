import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

const dataDir = config.db_path ?? join(process.cwd(), "data");
mkdirSync(dataDir, { recursive: true });

const sql = new Database(join(dataDir, "listr.db"));
sql.pragma("journal_mode = WAL");

sql.exec(`
  CREATE TABLE IF NOT EXISTS server_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
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

export function getServerId(): string {
  const row = sql.prepare("SELECT value FROM server_config WHERE key = 'server_id'").get() as { value: string } | undefined;
  if (row) return row.value;
  const id = randomUUID();
  sql.prepare("INSERT INTO server_config (key, value) VALUES ('server_id', ?)").run(id);
  return id;
}

export type EntityType = "category" | "list" | "item" | "asset";

function tableFor(type: EntityType): string {
  if (type === "category") return "categories";
  if (type === "list") return "lists";
  if (type === "asset") return "assets";
  return "items";
}

export function upsertEntity(type: EntityType, data: Record<string, unknown>, syncKey: string): boolean {
  const table = tableFor(type);
  const existing = sql
    .prepare(`SELECT updated_at FROM ${table} WHERE id = ?`)
    .get(data.id as string) as { updated_at: number } | undefined;
  if (existing && existing.updated_at >= (data.updated_at as number)) return false;
  const effectiveKey = type === "asset" ? "__global__" : syncKey;
  sql
    .prepare(
      `INSERT INTO ${table} (id, sync_key, updated_at, data) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET sync_key=excluded.sync_key, updated_at=excluded.updated_at, data=excluded.data`,
    )
    .run(data.id, effectiveKey, data.updated_at, JSON.stringify(data));
  return true;
}

export function getEntitiesSince(type: EntityType, syncKey: string, since: number): unknown[] {
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

export function applyTombstone(entityType: EntityType, entityId: string, deletedAt: number, syncKey: string): boolean {
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
  sql.prepare(`DELETE FROM ${tableFor(entityType)} WHERE id = ?`).run(entityId);
  return true;
}

export function getTombstonesSince(
  syncKey: string,
  since: number,
): { entity_type: string; entity_id: string; deleted_at: number }[] {
  return sql
    .prepare(`SELECT entity_type, entity_id, deleted_at FROM tombstones WHERE sync_key = ? AND deleted_at > ?`)
    .all(syncKey, since) as { entity_type: string; entity_id: string; deleted_at: number }[];
}
