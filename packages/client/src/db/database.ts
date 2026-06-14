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
  }
}

export const db = new ListrDB();
