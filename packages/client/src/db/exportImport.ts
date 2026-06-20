import type { AttributeDefinition, Item, List, ViewMode } from "@listr/shared";
import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import { deleteCategory, deleteList, deleteItem } from "./operations.js";

export interface NativeExport {
  listr_export: "1";
  exported_at: number;
  categories: ExportedCategory[];
}

interface ExportedCategory {
  id: string;
  deleted?: 1;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
  lists: ExportedList[];
}

interface ExportedList {
  id: string;
  deleted?: 1;
  name: string;
  icon: string;
  position: number;
  format_string: string | null;
  view_mode: ViewMode;
  items: ExportedItem[];
}

interface ExportedItem {
  id: string;
  deleted?: 1;
  title: string;
  position: number;
  attributes: Record<string, unknown>;
}

export interface ImportStats {
  categories: { created: number; updated: number; deleted: number };
  lists: { created: number; updated: number; deleted: number };
  items: { created: number; updated: number; deleted: number };
}

export function isNativeExport(obj: unknown): obj is NativeExport {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as any).listr_export === "1" &&
    Array.isArray((obj as any).categories)
  );
}

function buildListEntry(list: List, items: Item[]) {
  return {
    id: list.id,
    name: list.name,
    icon: list.icon,
    position: list.position,
    format_string: list.format_string,
    view_mode: list.view_mode,
    items: items.map((item) => ({
      id: item.id,
      title: item.title,
      position: item.position,
      attributes: item.attributes,
    })),
  };
}

export async function exportAllData(): Promise<NativeExport> {
  const [cats, lists, items] = await Promise.all([
    db.categories.orderBy("position").toArray(),
    db.lists.orderBy("position").toArray(),
    db.items.orderBy("position").toArray(),
  ]);

  const itemsByList = new Map<string, Item[]>();
  for (const item of items) {
    const arr = itemsByList.get(item.list_id);
    if (arr) arr.push(item);
    else itemsByList.set(item.list_id, [item]);
  }

  const listsByCategory = new Map<string, List[]>();
  for (const list of lists) {
    const arr = listsByCategory.get(list.category_id);
    if (arr) arr.push(list);
    else listsByCategory.set(list.category_id, [list]);
  }

  return {
    listr_export: "1",
    exported_at: Date.now(),
    categories: cats.map((cat) => ({
      id: cat.id,
      name: cat.name,
      color: cat.color,
      position: cat.position,
      schema: cat.schema,
      format_string: cat.format_string,
      macros: cat.macros,
      lists: (listsByCategory.get(cat.id) ?? []).map((list) =>
        buildListEntry(list, itemsByList.get(list.id) ?? [])
      ),
    })),
  };
}

export async function exportCategory(categoryId: string): Promise<NativeExport> {
  const cat = await db.categories.get(categoryId);
  if (!cat) throw new Error(`Category ${categoryId} not found`);
  const lists = await db.lists.where("category_id").equals(categoryId).sortBy("position");
  const items = await db.items
    .where("list_id").anyOf(lists.map((l) => l.id))
    .sortBy("position");
  const itemsByList = new Map<string, Item[]>();
  for (const item of items) {
    const arr = itemsByList.get(item.list_id);
    if (arr) arr.push(item);
    else itemsByList.set(item.list_id, [item]);
  }
  return {
    listr_export: "1",
    exported_at: Date.now(),
    categories: [{
      id: cat.id, name: cat.name, color: cat.color, position: cat.position,
      schema: cat.schema, format_string: cat.format_string, macros: cat.macros,
      lists: lists.map((list) => buildListEntry(list, itemsByList.get(list.id) ?? [])),
    }],
  };
}

export async function exportList(listId: string): Promise<NativeExport> {
  const list = await db.lists.get(listId);
  if (!list) throw new Error(`List ${listId} not found`);
  const cat = await db.categories.get(list.category_id);
  if (!cat) throw new Error(`Category ${list.category_id} not found`);
  const items = await db.items.where("list_id").equals(listId).sortBy("position");
  return {
    listr_export: "1",
    exported_at: Date.now(),
    categories: [{
      id: cat.id, name: cat.name, color: cat.color, position: cat.position,
      schema: cat.schema, format_string: cat.format_string, macros: cat.macros,
      lists: [buildListEntry(list, items)],
    }],
  };
}

export async function previewNativeImport(doc: NativeExport): Promise<ImportStats> {
  const [catKeys, listKeys, itemKeys] = await Promise.all([
    db.categories.toCollection().primaryKeys() as Promise<string[]>,
    db.lists.toCollection().primaryKeys() as Promise<string[]>,
    db.items.toCollection().primaryKeys() as Promise<string[]>,
  ]);

  const catSet = new Set(catKeys);
  const listSet = new Set(listKeys);
  const itemSet = new Set(itemKeys);

  const stats: ImportStats = {
    categories: { created: 0, updated: 0, deleted: 0 },
    lists: { created: 0, updated: 0, deleted: 0 },
    items: { created: 0, updated: 0, deleted: 0 },
  };

  for (const cat of doc.categories) {
    if (cat.deleted) {
      if (catSet.has(cat.id)) stats.categories.deleted++;
      continue;
    }
    if (catSet.has(cat.id)) stats.categories.updated++;
    else stats.categories.created++;

    for (const list of cat.lists ?? []) {
      if (list.deleted) {
        if (listSet.has(list.id)) stats.lists.deleted++;
        continue;
      }
      if (listSet.has(list.id)) stats.lists.updated++;
      else stats.lists.created++;

      for (const item of list.items ?? []) {
        if (item.deleted) {
          if (itemSet.has(item.id)) stats.items.deleted++;
          continue;
        }
        if (itemSet.has(item.id)) stats.items.updated++;
        else stats.items.created++;
      }
    }
  }

  return stats;
}

export async function applyNativeImport(doc: NativeExport): Promise<ImportStats> {
  const [catKeys, listKeys, itemKeys] = await Promise.all([
    db.categories.toCollection().primaryKeys() as Promise<string[]>,
    db.lists.toCollection().primaryKeys() as Promise<string[]>,
    db.items.toCollection().primaryKeys() as Promise<string[]>,
  ]);

  const catSet = new Set(catKeys);
  const listSet = new Set(listKeys);
  const itemSet = new Set(itemKeys);

  const stats: ImportStats = {
    categories: { created: 0, updated: 0, deleted: 0 },
    lists: { created: 0, updated: 0, deleted: 0 },
    items: { created: 0, updated: 0, deleted: 0 },
  };

  const timestamp = Date.now();
  const touchedCatIds: string[] = [];
  const touchedListIds: string[] = [];
  const touchedItemIds: string[] = [];
  const repositionedItemIds: string[] = [];
  const repositionedListIds: string[] = [];
  const categoriesWithNewLists = new Set<string>();

  for (const cat of doc.categories) {
    if (cat.deleted) {
      if (catSet.has(cat.id)) {
        await deleteCategory(cat.id);
        stats.categories.deleted++;
      }
      continue;
    }

    if (catSet.has(cat.id)) {
      await db.categories.update(cat.id, {
        name: cat.name,
        color: cat.color,
        schema: cat.schema,
        format_string: cat.format_string,
        macros: cat.macros,
        updated_at: timestamp,
      });
      stats.categories.updated++;
    } else {
      await db.categories.add({
        id: cat.id,
        name: cat.name,
        color: cat.color,
        position: cat.position,
        schema: cat.schema,
        format_string: cat.format_string,
        macros: cat.macros,
        created_at: timestamp,
        updated_at: timestamp,
      });
      stats.categories.created++;
    }
    touchedCatIds.push(cat.id);

    for (const list of cat.lists ?? []) {
      if (list.deleted) {
        if (listSet.has(list.id)) {
          await deleteList(list.id);
          stats.lists.deleted++;
        }
        continue;
      }

      if (listSet.has(list.id)) {
        await db.lists.update(list.id, {
          name: list.name,
          icon: list.icon,
          format_string: list.format_string,
          view_mode: list.view_mode,
          updated_at: timestamp,
        });
        stats.lists.updated++;
      } else {
        await db.lists.add({
          id: list.id,
          category_id: cat.id,
          name: list.name,
          icon: list.icon,
          position: list.position,
          format_string: list.format_string,
          view_mode: list.view_mode,
          created_at: timestamp,
          updated_at: timestamp,
        });
        stats.lists.created++;
        categoriesWithNewLists.add(cat.id);
      }
      touchedListIds.push(list.id);

      // Process items, tracking the import's array order for non-deleted items.
      const importedIds: string[] = [];
      for (const item of list.items ?? []) {
        if (item.deleted) {
          if (itemSet.has(item.id)) {
            await deleteItem(item.id);
            stats.items.deleted++;
          }
          continue;
        }

        if (itemSet.has(item.id)) {
          await db.items.update(item.id, {
            title: item.title,
            attributes: item.attributes,
            updated_at: timestamp,
          });
          stats.items.updated++;
        } else {
          await db.items.add({
            id: item.id,
            list_id: list.id,
            title: item.title,
            position: 0,
            attributes: item.attributes,
            created_at: timestamp,
            updated_at: timestamp,
          });
          stats.items.created++;
        }
        importedIds.push(item.id);
        touchedItemIds.push(item.id);
      }

      // Assign final positions: imported items in their import array order, then
      // any items not in the import in their existing relative order after them.
      // This handles both consistent insertions and full reorderings uniformly.
      const allItems = await db.items.where("list_id").equals(list.id).sortBy("position");
      const importedIdSet = new Set(importedIds);
      const nonImported = allItems.filter((i) => !importedIdSet.has(i.id));
      const orderedIds = [...importedIds, ...nonImported.map((i) => i.id)];
      const currentPositions = new Map(allItems.map((i) => [i.id, i.position]));
      for (let i = 0; i < orderedIds.length; i++) {
        if (currentPositions.get(orderedIds[i]) !== i) {
          await db.items.update(orderedIds[i], { position: i, updated_at: timestamp });
          if (!importedIdSet.has(orderedIds[i])) {
            repositionedItemIds.push(orderedIds[i]);
          }
          // Imported items are already in touchedItemIds; bulkGet below fetches
          // their final state including the updated position.
        }
      }
    }
  }

  // Dedup list positions where new lists were added to existing categories.
  for (const catId of categoriesWithNewLists) {
    const catLists = await db.lists.where("category_id").equals(catId).sortBy("position");
    const positions = catLists.map((l) => l.position);
    if (new Set(positions).size < positions.length) {
      for (let i = 0; i < catLists.length; i++) {
        if (catLists[i].position !== i) {
          await db.lists.update(catLists[i].id, { position: i, updated_at: timestamp });
          repositionedListIds.push(catLists[i].id);
        }
      }
    }
  }

  // Push all touched and repositioned entities to sync.
  const [updatedCats, updatedLists, updatedItems, reposLists, reposItems] = await Promise.all([
    db.categories.bulkGet(touchedCatIds),
    db.lists.bulkGet(touchedListIds),
    db.items.bulkGet(touchedItemIds),
    db.lists.bulkGet(repositionedListIds),
    db.items.bulkGet(repositionedItemIds),
  ]);
  for (const e of updatedCats) if (e) syncClient.pushEntity("category", e);
  for (const e of updatedLists) if (e) syncClient.pushEntity("list", e);
  for (const e of updatedItems) if (e) syncClient.pushEntity("item", e);
  for (const e of reposLists) if (e) syncClient.pushEntity("list", e);
  for (const e of reposItems) if (e) syncClient.pushEntity("item", e);

  return stats;
}
