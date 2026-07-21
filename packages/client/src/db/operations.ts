import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import { ENTITY_SCHEMA_VERSION, isCurrentSchemaVersion, type Board, type List, type Item, type AttributeDefinition, type ViewMode } from "@listr/shared";

// Boards and lists still use numeric `position` ordering; only items moved to
// after_id linked-list ordering.
const POSITION_STEP = 64;

// ---------------------------------------------------------------------------
// Chain utilities (after_id linked-list ordering)
// ---------------------------------------------------------------------------

/**
 * Walk a set of items linked by after_id and return them in display order.
 *
 * Robust to legacy `position`-ordered data. During the position→after_id
 * transition a client can hold a mix: locally-migrated rows carry after_id,
 * while rows pulled from a not-yet-migrated server still carry only `position`
 * (sync ingestion writes blobs verbatim; the Dexie upgrade only touches local
 * rows). Legacy items have no after_id, so they all share the `null` bucket —
 * we order that bucket (and every fork) by `position` first, so a pure-legacy
 * list renders in its intended order instead of creation order.
 *
 * Ordering within a fork: items with a `position` (legacy) come first, in
 * numeric order; items without (migrated) follow, by created_at. after_id items
 * that point at a legacy item splice in right after it. Orphans (dangling
 * after_id from concurrent deletes) are appended at the end.
 */
export function resolveChain<T extends { id: string; after_id?: string | null; created_at?: number; position?: number }>(
  items: T[],
): T[] {
  const byAfterId = new Map<string | null, T[]>();
  for (const item of items) {
    const key = item.after_id ?? null;
    if (!byAfterId.has(key)) byAfterId.set(key, []);
    byAfterId.get(key)!.push(item);
  }

  const bySequence = (a: T, b: T): number => {
    const pa = a.position, pb = b.position;
    if (pa != null && pb != null) return pa - pb;   // both legacy: numeric position
    if (pa != null) return -1;                      // legacy before migrated
    if (pb != null) return 1;
    return (a.created_at ?? 0) - (b.created_at ?? 0); // both migrated: created_at
  };

  const result: T[] = [];
  const visited = new Set<string>();

  function walk(afterId: string | null) {
    const nexts = (byAfterId.get(afterId) ?? []).slice().sort(bySequence);
    for (const item of nexts) {
      if (visited.has(item.id)) continue; // cycle guard
      visited.add(item.id);
      result.push(item);
      walk(item.id);
    }
  }

  walk(null);

  // Append orphans (items whose after_id points to a deleted/missing item)
  for (const item of items) {
    if (!visited.has(item.id)) result.push(item);
  }

  return result;
}

/**
 * Compute the after_id updates needed to move `movedId` so that it follows
 * `newAfterId`. Returns 1–3 records: the moved item, its old successor (which
 * skips over it), and the old successor of the target position (which now
 * follows the moved item). Only the changed records are returned.
 */
export function reorderByAfterId(
  items: { id: string; after_id: string | null }[],
  movedId: string,
  newAfterId: string | null,
): { id: string; after_id: string | null }[] {
  const moved = items.find((i) => i.id === movedId);
  if (!moved || moved.after_id === newAfterId) return [];

  const updates: { id: string; after_id: string | null }[] = [];

  // 1. The moved item now follows newAfterId
  updates.push({ id: movedId, after_id: newAfterId });

  // 2. The item that used to follow moved skips over it (follows moved's old predecessor)
  const movedOldSuccessor = items.find((i) => i.after_id === movedId && i.id !== movedId);
  if (movedOldSuccessor) {
    updates.push({ id: movedOldSuccessor.id, after_id: moved.after_id });
  }

  // 3. The item that used to follow newAfterId now follows moved
  const targetOldSuccessor = items.find(
    (i) => i.after_id === newAfterId && i.id !== movedId,
  );
  if (targetOldSuccessor && targetOldSuccessor.id !== movedOldSuccessor?.id) {
    updates.push({ id: targetOldSuccessor.id, after_id: movedId });
  }

  return updates;
}

// ---------------------------------------------------------------------------
// Legacy healing (position → after_id) for data that bypassed the Dexie upgrade
// ---------------------------------------------------------------------------

type HealableItem = {
  id: string;
  after_id?: string | null;
  created_at?: number;
  position?: number;
  schema_version?: number;
  updated_at?: number;
};

/**
 * Given all items in one list, if any is legacy (schema_version below current),
 * return the records to rewrite so the whole list becomes a clean after_id chain
 * in resolveChain (display) order, each stamped current with `position` dropped.
 * Only items whose after_id or schema_version actually changes are returned;
 * returns [] when the list is already current. Detection keys on schema_version
 * alone — never on which fields are present.
 */
type HealedItem<T> = T & { after_id: string | null; schema_version: number; updated_at: number };

export function computeChainHeal<T extends HealableItem>(listItems: T[], timestamp: number): HealedItem<T>[] {
  if (!listItems.some((i) => !isCurrentSchemaVersion(i.schema_version))) return [];

  const ordered = resolveChain(listItems);
  const updates: HealedItem<T>[] = [];
  let prevId: string | null = null;
  for (const item of ordered) {
    if ((item.after_id ?? null) !== prevId || !isCurrentSchemaVersion(item.schema_version)) {
      const healed = { ...item, after_id: prevId, schema_version: ENTITY_SCHEMA_VERSION, updated_at: timestamp };
      delete (healed as { position?: number }).position;
      updates.push(healed);
    }
    prevId = item.id;
  }
  return updates;
}

/**
 * Convert any locally-held legacy item rows to the current after_id shape and
 * push the healed records. Runs on startup and after each sync pull, because the
 * Dexie upgrade only migrates rows present at DB-open — it never touches items
 * pulled from a not-yet-migrated server (sync ingestion writes blobs verbatim).
 * Without this, a current-version client keeps re-pushing legacy blobs, which
 * the server now rejects (see upsertEntity). Idempotent: a no-op once clean.
 */
export async function healLegacyItems(): Promise<void> {
  const all = await db.items.toArray();
  if (!all.some((i) => !isCurrentSchemaVersion(i.schema_version))) return;

  const byList = new Map<string, Item[]>();
  for (const item of all) {
    const arr = byList.get(item.list_id);
    if (arr) arr.push(item);
    else byList.set(item.list_id, [item]);
  }

  const timestamp = now();
  for (const listItems of byList.values()) {
    const updates = computeChainHeal(listItems, timestamp);
    if (!updates.length) continue;
    await db.transaction("rw", db.items, async () => {
      for (const u of updates) await db.items.put(u);
    });
    for (const u of updates) syncClient.pushEntity("item", u);
  }
}

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

// --- Boards ---

export async function createBoard(
  name: string,
  color: string,
  schema: AttributeDefinition[] = [],
  formatString: string = "{title}",
  macros?: Record<string, string>,
): Promise<Board> {
  const maxPos = await db.boards.orderBy("position").last();
  const board: Board = {
    id: generateId(),
    name,
    color,
    position: (maxPos?.position ?? -POSITION_STEP) + POSITION_STEP,
    schema,
    format_string: formatString,
    macros,
    created_at: now(),
    updated_at: now(),
    schema_version: ENTITY_SCHEMA_VERSION,
  };
  await db.boards.add(board);
  syncClient.pushEntity("board", board);
  return board;
}

export async function updateBoard(
  id: string,
  updates: Partial<Pick<Board, "name" | "color" | "position" | "schema" | "format_string" | "macros">>,
): Promise<void> {
  await db.boards.update(id, { ...updates, updated_at: now(), schema_version: ENTITY_SCHEMA_VERSION });
  const updated = await db.boards.get(id);
  if (updated) syncClient.pushEntity("board", updated);
}

export async function deleteBoard(id: string): Promise<void> {
  const lists = await db.lists.where("board_id").equals(id).toArray();
  const itemIds: string[] = [];
  for (const list of lists) {
    const items = await db.items.where("list_id").equals(list.id).toArray();
    itemIds.push(...items.map((i) => i.id));
  }

  await db.transaction("rw", [db.boards, db.lists, db.items], async () => {
    for (const list of lists) {
      await db.items.where("list_id").equals(list.id).delete();
    }
    await db.lists.where("board_id").equals(id).delete();
    await db.boards.delete(id);
  });

  for (const itemId of itemIds) syncClient.pushDelete("item", itemId);
  for (const list of lists) syncClient.pushDelete("list", list.id);
  syncClient.pushDelete("board", id);
}

// --- Lists ---

export async function createList(
  name: string,
  boardId: string,
): Promise<List> {
  const maxPos = await db.lists.orderBy("position").last();
  const list: List = {
    id: generateId(),
    board_id: boardId,
    name,
    icon: "",
    position: (maxPos?.position ?? -POSITION_STEP) + POSITION_STEP,
    format_string: null,
    view_mode: "list",
    created_at: now(),
    updated_at: now(),
    schema_version: ENTITY_SCHEMA_VERSION,
  };
  await db.lists.add(list);
  syncClient.pushEntity("list", list);
  return list;
}

export async function updateList(
  id: string,
  updates: Partial<Pick<List, "name" | "icon" | "position" | "format_string" | "view_mode" | "board_id">>,
): Promise<void> {
  await db.lists.update(id, { ...updates, updated_at: now(), schema_version: ENTITY_SCHEMA_VERSION });
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
  if (!list?.board_id) return [];
  const board = await db.boards.get(list.board_id);
  return board?.schema ?? [];
}

/**
 * Create an item and link it into the list's after_id chain.
 * `afterId` controls placement:
 *   - undefined → append to the end of the list (default)
 *   - null      → insert at the very top
 *   - <id>      → insert immediately after that item
 * If an item already followed the insertion point, it is re-linked to follow the
 * new item so the chain stays intact.
 */
export async function createItem(
  listId: string,
  title: string,
  attributes: Record<string, unknown> = {},
  afterId?: string | null,
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

  const listItems = await db.items.where("list_id").equals(listId).toArray();
  const chain = resolveChain(listItems);

  // Resolve the predecessor pointer for the new item.
  let predecessorId: string | null;
  if (afterId === undefined) {
    predecessorId = chain.length > 0 ? chain[chain.length - 1].id : null;
  } else {
    predecessorId = afterId;
  }

  const id = generateId();
  const timestamp = now();
  const item: Item = {
    id,
    list_id: listId,
    title,
    after_id: predecessorId,
    created_at: timestamp,
    updated_at: timestamp,
    attributes: resolvedAttrs,
    schema_version: ENTITY_SCHEMA_VERSION,
  };

  // The item that used to follow the insertion point now follows the new item.
  const displaced = listItems.find((i) => (i.after_id ?? null) === predecessorId);

  await db.transaction("rw", db.items, async () => {
    await db.items.add(item);
    if (displaced) {
      await db.items.update(displaced.id, { after_id: id, updated_at: timestamp });
    }
  });

  syncClient.pushEntity("item", item);
  if (displaced) {
    syncClient.pushEntity("item", { ...displaced, after_id: id, updated_at: timestamp });
  }
  return item;
}

export async function updateItem(
  id: string,
  updates: Partial<Pick<Item, "title" | "after_id" | "attributes">>,
): Promise<void> {
  await db.items.update(id, { ...updates, updated_at: now(), schema_version: ENTITY_SCHEMA_VERSION });
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
  await db.items.update(id, { attributes, updated_at: now(), schema_version: ENTITY_SCHEMA_VERSION });
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

  const existingItems = await db.items.where("list_id").equals(listId).toArray();
  const chain = resolveChain(existingItems);
  let prevId: string | null = chain.length > 0 ? chain[chain.length - 1].id : null;
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

    const id = generateId();
    const item: Item = {
      id,
      list_id: listId,
      title: input.title,
      after_id: prevId,
      created_at: timestamp,
      updated_at: timestamp,
      attributes: resolvedAttrs,
      schema_version: ENTITY_SCHEMA_VERSION,
    };
    prevId = id;
    return item;
  });

  await db.items.bulkAdd(newItems);
  for (const item of newItems) syncClient.pushEntity("item", item);
  return newItems;
}
