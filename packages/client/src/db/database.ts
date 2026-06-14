import Dexie, { type EntityTable } from "dexie";
import type { Category, Item, List } from "@listr/shared";

export class ListrDB extends Dexie {
  categories!: EntityTable<Category, "id">;
  lists!: EntityTable<List, "id">;
  items!: EntityTable<Item, "id">;

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

      // Group lists: those with schemas get their own category,
      // uncategorized lists without schemas go into a "General" category
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
  }
}

export const db = new ListrDB();
