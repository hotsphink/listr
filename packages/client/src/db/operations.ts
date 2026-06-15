import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import type { Category, List, Item, AttributeDefinition, ViewMode } from "@listr/shared";

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for non-secure contexts (HTTP on mobile)
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function now(): number {
  return Date.now();
}

// --- Categories ---

export async function createCategory(
  name: string,
  color: string,
  schema: AttributeDefinition[] = [],
  formatString: string = "{title}",
  macros?: Record<string, string>,
): Promise<Category> {
  const maxPos = await db.categories.orderBy("position").last();
  const category: Category = {
    id: generateId(),
    name,
    color,
    position: (maxPos?.position ?? -1) + 1,
    schema,
    format_string: formatString,
    macros,
    created_at: now(),
    updated_at: now(),
  };
  await db.categories.add(category);
  syncClient.pushEntity("category", category);
  return category;
}

export async function updateCategory(
  id: string,
  updates: Partial<Pick<Category, "name" | "color" | "position" | "schema" | "format_string" | "macros">>,
): Promise<void> {
  await db.categories.update(id, { ...updates, updated_at: now() });
  const updated = await db.categories.get(id);
  if (updated) syncClient.pushEntity("category", updated);
}

export async function deleteCategory(id: string): Promise<void> {
  const lists = await db.lists.where("category_id").equals(id).toArray();
  const itemIds: string[] = [];
  for (const list of lists) {
    const items = await db.items.where("list_id").equals(list.id).toArray();
    itemIds.push(...items.map((i) => i.id));
  }

  await db.transaction("rw", [db.categories, db.lists, db.items], async () => {
    for (const list of lists) {
      await db.items.where("list_id").equals(list.id).delete();
    }
    await db.lists.where("category_id").equals(id).delete();
    await db.categories.delete(id);
  });

  for (const itemId of itemIds) syncClient.pushDelete("item", itemId);
  for (const list of lists) syncClient.pushDelete("list", list.id);
  syncClient.pushDelete("category", id);
}

// --- Lists ---

export async function createList(
  name: string,
  categoryId: string,
): Promise<List> {
  const maxPos = await db.lists.orderBy("position").last();
  const list: List = {
    id: generateId(),
    category_id: categoryId,
    name,
    icon: "",
    position: (maxPos?.position ?? -1) + 1,
    format_string: null,
    view_mode: "list",
    created_at: now(),
    updated_at: now(),
  };
  await db.lists.add(list);
  syncClient.pushEntity("list", list);
  return list;
}

export async function updateList(
  id: string,
  updates: Partial<Pick<List, "name" | "icon" | "position" | "format_string" | "view_mode" | "category_id">>,
): Promise<void> {
  await db.lists.update(id, { ...updates, updated_at: now() });
  const updated = await db.lists.get(id);
  if (updated) syncClient.pushEntity("list", updated);
}

export async function deleteList(id: string): Promise<void> {
  const items = await db.items.where("list_id").equals(id).toArray();

  await db.transaction("rw", [db.lists, db.items], async () => {
    await db.items.where("list_id").equals(id).delete();
    await db.lists.delete(id);
  });

  for (const item of items) syncClient.pushDelete("item", item.id);
  syncClient.pushDelete("list", id);
}

// --- Items ---

async function getSchemaForList(listId: string): Promise<AttributeDefinition[]> {
  const list = await db.lists.get(listId);
  if (!list?.category_id) return [];
  const category = await db.categories.get(list.category_id);
  return category?.schema ?? [];
}

export async function createItem(
  listId: string,
  title: string,
  attributes: Record<string, unknown> = {},
): Promise<Item> {
  const schema = await getSchemaForList(listId);

  const resolvedAttrs = { ...attributes };
  for (const def of schema) {
    if (resolvedAttrs[def.key] === undefined && def.default_value !== undefined) {
      resolvedAttrs[def.key] = def.default_value;
    }
    if (def.auto?.trigger === "on_create" && def.auto.source === "timestamp") {
      resolvedAttrs[def.key] = now();
    }
  }

  const maxPos = await db.items.where("list_id").equals(listId).last();
  const item: Item = {
    id: generateId(),
    list_id: listId,
    title,
    position: (maxPos?.position ?? -1) + 1,
    created_at: now(),
    updated_at: now(),
    attributes: resolvedAttrs,
  };
  await db.items.add(item);
  syncClient.pushEntity("item", item);
  return item;
}

export async function updateItem(
  id: string,
  updates: Partial<Pick<Item, "title" | "position" | "attributes">>,
): Promise<void> {
  await db.items.update(id, { ...updates, updated_at: now() });
  const updated = await db.items.get(id);
  if (updated) syncClient.pushEntity("item", updated);
}

export async function updateItemAttribute(
  id: string,
  key: string,
  value: unknown,
): Promise<void> {
  const item = await db.items.get(id);
  if (!item) throw new Error(`Item ${id} not found`);
  const attributes = { ...item.attributes, [key]: value };
  await db.items.update(id, { attributes, updated_at: now() });
  const updated = await db.items.get(id);
  if (updated) syncClient.pushEntity("item", updated);
}

export async function deleteItem(id: string): Promise<void> {
  await db.items.delete(id);
  syncClient.pushDelete("item", id);
}

export async function bulkCreateItems(
  listId: string,
  items: Array<{ title: string; attributes?: Record<string, unknown> }>,
): Promise<Item[]> {
  const schema = await getSchemaForList(listId);

  const maxPos = await db.items.where("list_id").equals(listId).last();
  let pos = (maxPos?.position ?? -1) + 1;
  const timestamp = now();

  const newItems: Item[] = items.map((input) => {
    const resolvedAttrs = { ...input.attributes };
    for (const def of schema) {
      if (resolvedAttrs[def.key] === undefined && def.default_value !== undefined) {
        resolvedAttrs[def.key] = def.default_value;
      }
      if (def.auto?.trigger === "on_create" && def.auto.source === "timestamp") {
        resolvedAttrs[def.key] = timestamp;
      }
    }

    return {
      id: generateId(),
      list_id: listId,
      title: input.title,
      position: pos++,
      created_at: timestamp,
      updated_at: timestamp,
      attributes: resolvedAttrs,
    };
  });

  await db.items.bulkAdd(newItems);
  for (const item of newItems) syncClient.pushEntity("item", item);
  return newItems;
}
