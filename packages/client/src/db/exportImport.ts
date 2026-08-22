import { ENTITY_SCHEMA_VERSION, type AttributeDefinition, type Item, type List, type ViewMode } from "@listr/shared";
import { db } from "./database.js";
import { syncClient } from "../sync/SyncClient.js";
import { deleteBoard, deleteList, deleteItem, resolveChain } from "./operations.js";
import { assetToSync, assetFromSync, registerAsset } from "../sync/assetStore.js";
import { shouldDeleteOnTombstone } from "../sync/mergeLogic.js";

export interface NativeExport {
  listr_export: "1" | "2";
  exported_at: number;
  boards: ExportedBoard[];
  /** v2+: flat tombstones for boards/lists/items deleted since the source's last export.
   *  Not nested under boards/lists — a deleted list/item's parent may itself be gone or
   *  unrelated, and local tombstones carry no parent linkage to reconstruct that. */
  tombstones?: ExportedTombstone[];
  /** v2+: asset blobs (images/files) referenced by this export. */
  assets?: ExportedAsset[];
}

type EntityKind = "board" | "list" | "item";

interface ExportedTombstone {
  entity_type: EntityKind;
  entity_id: string;
  deleted_at: number;
}

type ExportedAsset = ReturnType<typeof assetToSync>;

interface ExportedBoard {
  id: string;
  deleted?: 1;
  name: string;
  color: string;
  position: number;
  schema: AttributeDefinition[];
  format_string: string;
  macros?: Record<string, string>;
  /** Custom sync namespace this board uses instead of the default (see Board.sync_key). */
  sync_key?: string;
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
  attributes: Record<string, unknown>;
}

export interface ImportStats {
  boards: { created: number; updated: number; deleted: number };
  lists: { created: number; updated: number; deleted: number };
  items: { created: number; updated: number; deleted: number };
  assets: { created: number; skipped: number };
}

function emptyStats(): ImportStats {
  return {
    boards: { created: 0, updated: 0, deleted: 0 },
    lists: { created: 0, updated: 0, deleted: 0 },
    items: { created: 0, updated: 0, deleted: 0 },
    assets: { created: 0, skipped: 0 },
  };
}

export function isNativeExport(obj: unknown): obj is NativeExport {
  return (
    typeof obj === "object" &&
    obj !== null &&
    ((obj as any).listr_export === "1" || (obj as any).listr_export === "2") &&
    Array.isArray((obj as any).boards)
  );
}

// Matches macro/format-string/attribute references like hash://1a2b3c....png
// produced by BoardFormModal's "Insert image asset" action.
const ASSET_HASH_RE = /hash:\/\/([0-9a-f]{20})\.[a-z0-9]+/gi;

/** Pure helper: finds asset IDs referenced from a board's/list's format strings, a
 *  board's macros, and items' string-valued attributes — used to scope asset export
 *  to a single board/list without dumping every asset in the local DB. */
export function extractReferencedAssetIds(
  board: { format_string?: string | null; macros?: Record<string, string> },
  lists: { format_string?: string | null }[],
  items: { attributes: Record<string, unknown> }[],
): Set<string> {
  const ids = new Set<string>();
  const scan = (s: string | null | undefined) => {
    if (!s) return;
    for (const m of s.matchAll(ASSET_HASH_RE)) ids.add(m[1]);
  };
  scan(board.format_string);
  for (const v of Object.values(board.macros ?? {})) scan(v);
  for (const l of lists) scan(l.format_string);
  for (const i of items) {
    for (const v of Object.values(i.attributes)) {
      if (typeof v === "string") scan(v);
    }
  }
  return ids;
}

async function exportAssetsByIds(ids: Set<string>): Promise<ExportedAsset[]> {
  if (ids.size === 0) return [];
  const found = await db.assets.bulkGet([...ids]);
  return found.filter((a): a is NonNullable<typeof a> => !!a).map(assetToSync);
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
      attributes: item.attributes,
    })),
  };
}

export async function exportAllData(): Promise<NativeExport> {
  const [allBoards, lists, allItems, tombstoneRows, allAssets] = await Promise.all([
    db.boards.orderBy("position").toArray(),
    db.lists.orderBy("position").toArray(),
    db.items.toArray(),
    db.tombstones.toArray(),
    db.assets.toArray(),
  ]);

  const itemsByList = new Map<string, Item[]>();
  for (const list of lists) {
    const raw = allItems.filter((i) => i.list_id === list.id);
    itemsByList.set(list.id, resolveChain(raw));
  }

  const listsByBoard = new Map<string, List[]>();
  for (const list of lists) {
    const arr = listsByBoard.get(list.board_id);
    if (arr) arr.push(list);
    else listsByBoard.set(list.board_id, [list]);
  }

  const tombstones: ExportedTombstone[] = tombstoneRows
    .filter((t): t is typeof t & { entity_type: EntityKind } =>
      t.entity_type === "board" || t.entity_type === "list" || t.entity_type === "item")
    .map((t) => ({ entity_type: t.entity_type, entity_id: t.entity_id, deleted_at: t.deleted_at }));

  return {
    listr_export: "2",
    exported_at: Date.now(),
    boards: allBoards.map((board) => ({
      id: board.id,
      name: board.name,
      color: board.color,
      position: board.position,
      schema: board.schema,
      format_string: board.format_string,
      macros: board.macros,
      sync_key: board.sync_key,
      lists: (listsByBoard.get(board.id) ?? []).map((list) =>
        buildListEntry(list, itemsByList.get(list.id) ?? [])
      ),
    })),
    tombstones,
    assets: allAssets.map(assetToSync),
  };
}

export async function exportBoard(boardId: string): Promise<NativeExport> {
  const board = await db.boards.get(boardId);
  if (!board) throw new Error(`Board ${boardId} not found`);
  const lists = await db.lists.where("board_id").equals(boardId).sortBy("position");
  const allItems = await db.items.where("list_id").anyOf(lists.map((l) => l.id)).toArray();
  const itemsByList = new Map<string, Item[]>();
  for (const list of lists) {
    const raw = allItems.filter((i) => i.list_id === list.id);
    itemsByList.set(list.id, resolveChain(raw));
  }
  const assets = await exportAssetsByIds(extractReferencedAssetIds(board, lists, allItems));
  return {
    listr_export: "2",
    exported_at: Date.now(),
    boards: [{
      id: board.id, name: board.name, color: board.color, position: board.position,
      schema: board.schema, format_string: board.format_string, macros: board.macros,
      sync_key: board.sync_key,
      lists: lists.map((list) => buildListEntry(list, itemsByList.get(list.id) ?? [])),
    }],
    assets,
  };
}

export async function exportList(listId: string): Promise<NativeExport> {
  const list = await db.lists.get(listId);
  if (!list) throw new Error(`List ${listId} not found`);
  const board = await db.boards.get(list.board_id);
  if (!board) throw new Error(`Board ${list.board_id} not found`);
  const rawItems = await db.items.where("list_id").equals(listId).toArray();
  const items = resolveChain(rawItems);
  const assets = await exportAssetsByIds(extractReferencedAssetIds(board, [list], items));
  return {
    listr_export: "2",
    exported_at: Date.now(),
    boards: [{
      id: board.id, name: board.name, color: board.color, position: board.position,
      schema: board.schema, format_string: board.format_string, macros: board.macros,
      sync_key: board.sync_key,
      lists: [buildListEntry(list, items)],
    }],
    assets,
  };
}

interface TombstoneAction extends ExportedTombstone {
  existedLocally: boolean;
  shouldDelete: boolean;
}

/** For each flat tombstone entry, checks the local entity (if any) and decides —
 *  via the same LWW rule live sync uses — whether the deletion actually wins. An
 *  independently-newer local edit survives an older imported deletion. */
async function resolveTombstoneActions(tombstones: ExportedTombstone[]): Promise<TombstoneAction[]> {
  const byType: Record<EntityKind, ExportedTombstone[]> = { board: [], list: [], item: [] };
  for (const t of tombstones) byType[t.entity_type].push(t);

  const [boards, lists, items] = await Promise.all([
    db.boards.bulkGet(byType.board.map((t) => t.entity_id)),
    db.lists.bulkGet(byType.list.map((t) => t.entity_id)),
    db.items.bulkGet(byType.item.map((t) => t.entity_id)),
  ]);

  const actions: TombstoneAction[] = [];
  byType.board.forEach((t, i) => {
    actions.push({ ...t, existedLocally: !!boards[i], shouldDelete: shouldDeleteOnTombstone(boards[i], t.deleted_at) });
  });
  byType.list.forEach((t, i) => {
    actions.push({ ...t, existedLocally: !!lists[i], shouldDelete: shouldDeleteOnTombstone(lists[i], t.deleted_at) });
  });
  byType.item.forEach((t, i) => {
    actions.push({ ...t, existedLocally: !!items[i], shouldDelete: shouldDeleteOnTombstone(items[i], t.deleted_at) });
  });
  return actions;
}

async function applyTombstoneActions(actions: TombstoneAction[], stats: ImportStats): Promise<void> {
  for (const a of actions) {
    if (!a.shouldDelete) continue; // local entity is independently newer — keep it
    if (a.existedLocally) {
      if (a.entity_type === "board") await db.boards.delete(a.entity_id);
      else if (a.entity_type === "list") await db.lists.delete(a.entity_id);
      else await db.items.delete(a.entity_id);
      if (a.entity_type === "board") stats.boards.deleted++;
      else if (a.entity_type === "list") stats.lists.deleted++;
      else stats.items.deleted++;
    }
    // Preserve the original deleted_at (not now()) so LWW ordering against
    // independent edits stays correct, and push so the connected target server
    // (which may never have seen this entity) learns of the deletion too.
    syncClient.pushDelete(a.entity_type, a.entity_id, a.deleted_at);
  }
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

  const stats = emptyStats();

  const tombstoneActions = await resolveTombstoneActions(doc.tombstones ?? []);
  for (const a of tombstoneActions) {
    if (!a.existedLocally || !a.shouldDelete) continue;
    if (a.entity_type === "board") stats.boards.deleted++;
    else if (a.entity_type === "list") stats.lists.deleted++;
    else stats.items.deleted++;
  }

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

  for (const asset of doc.assets ?? []) {
    const exists = await db.assets.get(asset.id as string);
    if (exists) stats.assets.skipped++;
    else stats.assets.created++;
  }

  return stats;
}

export async function applyNativeImport(doc: NativeExport): Promise<ImportStats> {
  const stats = emptyStats();

  // Apply deletions first — the regular upsert loop below re-reads boardSet/
  // listSet/itemSet afterward, so it sees post-deletion state.
  const tombstoneActions = await resolveTombstoneActions(doc.tombstones ?? []);
  await applyTombstoneActions(tombstoneActions, stats);

  const [boardKeys, listKeys, itemKeys] = await Promise.all([
    db.boards.toCollection().primaryKeys() as Promise<string[]>,
    db.lists.toCollection().primaryKeys() as Promise<string[]>,
    db.items.toCollection().primaryKeys() as Promise<string[]>,
  ]);

  const boardSet = new Set(boardKeys);
  const listSet = new Set(listKeys);
  const itemSet = new Set(itemKeys);

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
        sync_key: board.sync_key,
        updated_at: timestamp,
        schema_version: ENTITY_SCHEMA_VERSION,
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
        sync_key: board.sync_key,
        created_at: timestamp,
        updated_at: timestamp,
        schema_version: ENTITY_SCHEMA_VERSION,
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
          schema_version: ENTITY_SCHEMA_VERSION,
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
          schema_version: ENTITY_SCHEMA_VERSION,
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
            schema_version: ENTITY_SCHEMA_VERSION,
          });
          stats.items.updated++;
        } else {
          await db.items.add({
            id: item.id,
            list_id: list.id,
            title: item.title,
            after_id: null, // will be fixed in the chain-build step below
            attributes: item.attributes,
            created_at: timestamp,
            updated_at: timestamp,
            schema_version: ENTITY_SCHEMA_VERSION,
          });
          stats.items.created++;
        }
        importedIds.push(item.id);
        touchedItemIds.push(item.id);
      }

      // Build the after_id chain: imported items first (in import order),
      // then non-imported items (in their existing chain order), then the add point.
      const rawItems = await db.items.where("list_id").equals(list.id).toArray();
      const importedIdSet = new Set(importedIds);
      const existingChain = resolveChain(rawItems).filter((i) => !importedIdSet.has(i.id));
      const orderedIds = [...importedIds, ...existingChain.map((i) => i.id)];
      const currentAfterId = new Map(rawItems.map((i) => [i.id, i.after_id]));
      let prevId: string | null = null;
      for (const id of orderedIds) {
        if (currentAfterId.get(id) !== prevId) {
          await db.items.update(id, { after_id: prevId, updated_at: timestamp });
          if (!importedIdSet.has(id)) repositionedItemIds.push(id);
        }
        prevId = id;
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

  // Assets: content-addressed, so a hit is a no-op locally, but always push —
  // the target server may not have it yet even if this client's cache does.
  for (const encoded of doc.assets ?? []) {
    const asset = assetFromSync(encoded);
    const exists = await db.assets.get(asset.id);
    if (!exists) {
      await db.assets.put(asset);
      await registerAsset(asset);
      stats.assets.created++;
    } else {
      stats.assets.skipped++;
    }
    syncClient.pushEntity("asset", assetToSync(asset));
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

/**
 * Given an ordered list of item IDs from an AI import and all items currently
 * in the list, returns the after_id updates needed so that:
 *   - imported items appear first, in import array order
 *   - items not in the import are appended after, in their existing chain order
 * Only items whose after_id actually changes are returned.
 */
export function computeAiImportOrder(
  importedIds: string[],
  allItems: { id: string; after_id: string | null }[],
): { id: string; after_id: string | null }[] {
  const chain = resolveChain(allItems);
  const existingIds = new Set(chain.map((i) => i.id));
  const knownImported = importedIds.filter((id) => existingIds.has(id));
  const importedSet = new Set(knownImported);
  const nonImported = chain.filter((i) => !importedSet.has(i.id)).map((i) => i.id);
  const orderedIds = [...knownImported, ...nonImported];
  const currentAfterId = new Map(allItems.map((i) => [i.id, i.after_id]));
  const updates: { id: string; after_id: string | null }[] = [];
  let prevId: string | null = null;
  for (const id of orderedIds) {
    if (currentAfterId.get(id) !== prevId) updates.push({ id, after_id: prevId });
    prevId = id;
  }
  return updates;
}
