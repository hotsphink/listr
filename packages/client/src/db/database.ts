import Dexie, { type EntityTable, type Table } from "dexie";
import type { Asset, Board, Item, List } from "@listr/shared";

export interface SyncConfig {
  id: string; // always "default"
  sync_url: string;
  sync_key: string;
  client_id: string;
  enabled: boolean;
  last_sync_at: number;
  last_sync_key?: string;
}

export interface SyncEndpoint {
  id: string;
  host: string;
  port: number;
  enabled: boolean;
  secure: boolean;
  last_server_id: string | null;
  position: number;
}

export interface LocalTombstone {
  id: string; // `${entity_type}:${entity_id}`
  entity_type: string;
  entity_id: string;
  deleted_at: number;
}

export class ListrDB extends Dexie {
  boards!: EntityTable<Board, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;
  assets!: EntityTable<Asset, "id">;
  sync_config!: Table<SyncConfig, string>;
  tombstones!: Table<LocalTombstone, string>;
  sync_endpoints!: Table<SyncEndpoint, string>;

  constructor() {
    super("listr");

    // ── Data-format versioning ────────────────────────────────────────────
    // IndexedDB persists the Dexie schema version below; when a client with a
    // higher declared version opens an older local DB, the matching `.upgrade()`
    // runs ONCE to migrate existing rows forward.
    //
    // Whenever you change the stored shape of an entity (add/rename/remove a
    // field, change how ordering is represented, etc.):
    //   1. Add a NEW `this.version(N+1).stores(...).upgrade(...)` block below.
    //      Never edit an existing version block.
    //   2. If the changed field is also synced to the server, bump the sync
    //      PROTOCOL_VERSION (src/sync/protocol.ts) and the server's supported
    //      range so old- and new-format clients can't share one server and
    //      corrupt each other's data. NOTE: `.upgrade()` migrates only LOCAL
    //      data at open time — it does NOT run on entities pulled over sync.
    // See memory: project_data_format_versioning.
    // ──────────────────────────────────────────────────────────────────────

    this.version(1).stores({
      categories: "id, position",
      lists: "id, category_id, position",
      items: "id, list_id, position, title",
    });

    this.version(2).stores({
      categories: "id, position",
      lists: "id, category_id, position",
      items: "id, list_id, position, title",
    }).upgrade(async (tx) => {
      const lists = await tx.table("lists").toArray();
      const categories = tx.table("categories");
      const listsTable = tx.table("lists");
      const now = Date.now();

      let generalCatId: string | null = null;

      for (const list of lists) {
        if (list.schema && list.schema.length > 0 && !list.category_id) {
          const catId = crypto.randomUUID();
          await categories.add({
            id: catId,
            name: list.name,
            color: "#5b8def",
            position: list.position,
            schema: list.schema,
            format_string: list.format_string || "{title}",
            created_at: list.created_at,
            updated_at: list.updated_at,
          });
          await listsTable.update(list.id, { category_id: catId, format_string: null });
        } else if (!list.category_id) {
          if (!generalCatId) {
            generalCatId = crypto.randomUUID();
            await categories.add({
              id: generalCatId,
              name: "General",
              color: "#888888",
              position: 999,
              schema: [],
              format_string: "{title}",
              created_at: now,
              updated_at: now,
            });
          }
          await listsTable.update(list.id, { category_id: generalCatId, format_string: null });
        }
      }

      await listsTable.toCollection().modify((list: any) => {
        delete list.schema;
      });
    });

    // Adds updated_at index (for incremental sync), sync_config, and tombstones tables
    this.version(3).stores({
      categories: "id, position, updated_at",
      lists: "id, category_id, position, updated_at",
      items: "id, list_id, position, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
    });

    // Adds global assets table for synced image/file storage
    this.version(4).stores({
      categories: "id, position, updated_at",
      lists: "id, category_id, position, updated_at",
      items: "id, list_id, position, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
    });

    // Adds sync_endpoints table for multi-server sync configuration
    this.version(5).stores({
      categories: "id, position, updated_at",
      lists: "id, category_id, position, updated_at",
      items: "id, list_id, position, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
    });

    // Renames categories → boards; renames lists.category_id → lists.board_id
    this.version(6).stores({
      boards: "id, position, updated_at",
      categories: null,
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, position, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
    }).upgrade(async (tx) => {
      const oldBoards = await tx.table("categories").toArray();
      if (oldBoards.length > 0) await tx.table("boards").bulkAdd(oldBoards);
      await tx.table("lists").toCollection().modify((list: any) => {
        if (list.category_id !== undefined) {
          list.board_id = list.category_id;
          delete list.category_id;
        }
      });
    });
  }
}

export const db = new ListrDB();
