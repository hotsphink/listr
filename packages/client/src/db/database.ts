import Dexie, { type EntityTable, type Table } from "dexie";
import type { Asset, Board, Item, List, IntegrationResult } from "@listr/shared";
import { ENTITY_SCHEMA_VERSION, migrateListToAfterId } from "@listr/shared";

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
  sync_key?: string; // which namespace this delete belongs to
}

export interface KeySyncState {
  key: string;
  last_sync_at: number;
}

export interface SharedKey {
  key: string; // primary key — the sync_key to subscribe to
  added_at: number;
  board_name?: string; // display hint from the share QR
}

export class ListrDB extends Dexie {
  boards!: EntityTable<Board, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;
  assets!: EntityTable<Asset, "id">;
  integration_results!: EntityTable<IntegrationResult, "id">;
  sync_config!: Table<SyncConfig, string>;
  tombstones!: Table<LocalTombstone, string>;
  sync_endpoints!: Table<SyncEndpoint, string>;
  key_sync_state!: Table<KeySyncState, string>;
  shared_keys!: Table<SharedKey, string>;

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

    // Replaces numeric `position` on items with `after_id` linked-list pointers.
    // Uses the shared migrateListToAfterId so local rows convert identically to
    // the offline server migration (see packages/shared/src/migrate-after-id.ts).
    this.version(7).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
    }).upgrade(async (tx) => {
      const allItems = await tx.table("items").toArray();
      const ts = Date.now();

      // Group items by list.
      const byList = new Map<string, any[]>();
      for (const item of allItems) {
        if (!byList.has(item.list_id)) byList.set(item.list_id, []);
        byList.get(item.list_id)!.push(item);
      }

      // Convert each list to an after_id chain, then strip the old position field
      // and stamp the new record shape version.
      for (const [listId, items] of byList) {
        const { afterIds, mixed } = migrateListToAfterId(items);
        if (mixed) {
          console.warn(`[migrate v7] list ${listId} mixed position/after_id items; order is heuristic`);
        }
        for (const item of items) {
          await tx.table("items").update(item.id, {
            after_id: afterIds.get(item.id) ?? null,
            schema_version: ENTITY_SCHEMA_VERSION,
          });
        }
      }

      // Remove position from all items.
      await tx.table("items").toCollection().modify((item: any) => {
        delete item.position;
      });
    });

    // Adds key_sync_state table for per-namespace incremental sync timestamps (v3 protocol).
    this.version(8).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
    });

    // Adds shared_keys table for explicit key subscriptions (board sharing via QR).
    this.version(9).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
    });

    // Adds integration_results table for server-side integration status tracking.
    this.version(10).stores({
      boards: "id, position, updated_at",
      lists: "id, board_id, position, updated_at",
      items: "id, list_id, after_id, title, updated_at",
      sync_config: "id",
      tombstones: "id, entity_type, deleted_at",
      assets: "id, updated_at",
      sync_endpoints: "id, position",
      key_sync_state: "key",
      shared_keys: "key",
      integration_results: "id, item_id, integration_id, status, updated_at",
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
