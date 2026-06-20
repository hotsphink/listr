import type { AttributeDefinition, Item, List, ViewMode } from "@listr/shared";
import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import { deleteBoard, deleteList, deleteItem } from "./operations.js";

export interface NativeExport {
  listr_export: "1";
  exported_at: number;
  boards: ExportedBoard[];
}

interface ExportedBoard {
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
  boards: { created: number; updated: number; deleted: number };
  lists: { created: number; updated: number; deleted: number };
  items: { created: number; updated: number; deleted: number };
}

export function isNativeExport(obj: unknown): obj is NativeExport {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as any).listr_export === "1" &&
    Array.isArray((obj as any).boards)
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
  const [allBoards, lists, items] = await Promise.all([
    db.boards.orderBy("position").toArray(),
    db.lists.orderBy("position").toArray(),
    db.items.orderBy("position").toArray(),
  ]);

  const itemsByList = new Map<string, Item[]>();
  for (const item of items) {
    const arr = itemsByList.get(item.list_id);
    if (arr) arr.push(item);
    else itemsByList.set(item.list_id, [item]);
  }

  const listsByBoard = new Map<string, List[]>();
  for (const list of lists) {
    const arr = listsByBoard.get(list.board_id);
    if (arr) arr.push(list);
    else listsByBoard.set(list.board_id, [list]);
  }

  return {
    listr_export: "1",
    exported_at: Date.now(),
    boards: allBoards.map((board) => ({
      id: board.id,
      name: board.name,
      color: board.color,
      position: board.position,
      schema: board.schema,
      format_string: board.format_string,
      macros: board.macros,
      lists: (listsByBoard.get(board.id) ?? []).map((list) =>
        buildListEntry(list, itemsByList.get(list.id) ?? [])
      ),
    })),
  };
}

export async function exportBoard(boardId: string): Promise<NativeExport> {
  const board = await db.boards.get(boardId);
  if (!board) throw new Error(`Board ${boardId} not found`);
  const lists = await db.lists.where("board_id").equals(boardId).sortBy("position");
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
    boards: [{
      id: board.id, name: board.name, color: board.color, position: board.position,
      schema: board.schema, format_string: board.format_string, macros: board.macros,
      lists: lists.map((list) => buildListEntry(list, itemsByList.get(list.id) ?? [])),
    }],
  };
}

export async function exportList(listId: string): Promise<NativeExport> {
  const list = await db.lists.get(listId);
  if (!list) throw new Error(`List ${listId} not found`);
  const board = await db.boards.get(list.board_id);
  if (!board) throw new Error(`Board ${list.board_id} not found`);
  const items = await db.items.where("list_id").equals(listId).sortBy("position");
  return {
    listr_export: "1",
    exported_at: Date.now(),
    boards: [{
      id: board.id, name: board.name, color: board.color, position: board.position,
      schema: board.schema, format_string: board.format_string, macros: board.macros,
      lists: [buildListEntry(list, items)],
    }],
  };
}

export async function previewNativeImport(doc: NativeExport): Promise<ImportStats> {
  const [boardKeys, listKeys, itemKeys] = await Promise.all([
    db.boards.toCollection().primaryKeys() as Promise<string[]>,
    db.lists.toCollection().primaryKeys() as Promise<string[]>,
    db.items.toCollection().primaryKeys() as Promise<string[]>,
  ]);

  const boardSet = new Set(boardKeys);
  const listSet = new Set(listKeys);
  const itemSet = new Set(itemKeys);

  const stats: ImportStats = {
    boards: { created: 0, updated: 0, deleted: 0 },
    lists: { created: 0, updated: 0, deleted: 0 },
    items: { created: 0, updated: 0, deleted: 0 },
  };

  for (const board of doc.boards) {
    if (board.deleted) {
      if (boardSet.has(board.id)) stats.boards.deleted++;
      continue;
    }
    if (boardSet.has(board.id)) stats.boards.updated++;
    else stats.boards.created++;

    for (const list of board.lists ?? []) {
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
  const [boardKeys, listKeys, itemKeys] = await Promise.all([
    db.boards.toCollection().primaryKeys() as Promise<string[]>,
    db.lists.toCollection().primaryKeys() as Promise<string[]>,
    db.items.toCollection().primaryKeys() as Promise<string[]>,
  ]);

  const boardSet = new Set(boardKeys);
  const listSet = new Set(listKeys);
  const itemSet = new Set(itemKeys);

  const stats: ImportStats = {
    boards: { created: 0, updated: 0, deleted: 0 },
    lists: { created: 0, updated: 0, deleted: 0 },
    items: { created: 0, updated: 0, deleted: 0 },
  };

  const timestamp = Date.now();
  const touchedBoardIds: string[] = [];
  const touchedListIds: string[] = [];
  const touchedItemIds: string[] = [];
  const repositionedItemIds: string[] = [];
  const repositionedListIds: string[] = [];
  const boardsWithNewLists = new Set<string>();

  for (const board of doc.boards) {
    if (board.deleted) {
      if (boardSet.has(board.id)) {
        await deleteBoard(board.id);
        stats.boards.deleted++;
      }
      continue;
    }

    if (boardSet.has(board.id)) {
      await db.boards.update(board.id, {
        name: board.name,
        color: board.color,
        schema: board.schema,
        format_string: board.format_string,
        macros: board.macros,
        updated_at: timestamp,
      });
      stats.boards.updated++;
    } else {
      await db.boards.add({
        id: board.id,
        name: board.name,
        color: board.color,
        position: board.position,
        schema: board.schema,
        format_string: board.format_string,
        macros: board.macros,
        created_at: timestamp,
        updated_at: timestamp,
      });
      stats.boards.created++;
    }
    touchedBoardIds.push(board.id);

    for (const list of board.lists ?? []) {
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
          board_id: board.id,
          name: list.name,
          icon: list.icon,
          position: list.position,
          format_string: list.format_string,
          view_mode: list.view_mode,
          created_at: timestamp,
          updated_at: timestamp,
        });
        stats.lists.created++;
        boardsWithNewLists.add(board.id);
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

  // Dedup list positions where new lists were added to existing boards.
  for (const boardId of boardsWithNewLists) {
    const boardLists = await db.lists.where("board_id").equals(boardId).sortBy("position");
    const positions = boardLists.map((l) => l.position);
    if (new Set(positions).size < positions.length) {
      for (let i = 0; i < boardLists.length; i++) {
        if (boardLists[i].position !== i) {
          await db.lists.update(boardLists[i].id, { position: i, updated_at: timestamp });
          repositionedListIds.push(boardLists[i].id);
        }
      }
    }
  }

  // Push all touched and repositioned entities to sync.
  const [updatedBoards, updatedLists, updatedItems, reposLists, reposItems] = await Promise.all([
    db.boards.bulkGet(touchedBoardIds),
    db.lists.bulkGet(touchedListIds),
    db.items.bulkGet(touchedItemIds),
    db.lists.bulkGet(repositionedListIds),
    db.items.bulkGet(repositionedItemIds),
  ]);
  for (const e of updatedBoards) if (e) syncClient.pushEntity("board", e);
  for (const e of updatedLists) if (e) syncClient.pushEntity("list", e);
  for (const e of updatedItems) if (e) syncClient.pushEntity("item", e);
  for (const e of reposLists) if (e) syncClient.pushEntity("list", e);
  for (const e of reposItems) if (e) syncClient.pushEntity("item", e);

  return stats;
}
