import Dexie, { type EntityTable, type Table } from "dexie";
import type { Asset, Category, Item, List } from "@listr/shared";

export interface SyncConfig {
  id: string; // always "default"
  sync_url: string;
  sync_key: string;
  client_id: string;
  enabled: boolean;
  last_sync_at: number;
}

export interface LocalTombstone {
  id: string; // `${entity_type}:${entity_id}`
  entity_type: string;
  entity_id: string;
  deleted_at: number;
}

export class ListrDB extends Dexie {
  categories!: EntityTable<Category, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;
  assets!: EntityTable<Asset, "id">;
  sync_config!: Table<SyncConfig, string>;
  tombstones!: Table<LocalTombstone, string>;

  constructor() {
    super("listr");

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
  }
}

export const db = new ListrDB();
