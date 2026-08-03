import { type Component, For, Show, Switch, Match, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { from } from "solid-js";
import { useParams, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { renderFormatStringHtml } from "@listr/shared";
import type { AttributeDefinition, Board, Integration, Item, List, IntegrationStatus } from "@listr/shared";
import { db } from "../db/database.js";
import { createItem, updateItem, deleteItem, updateList, deleteList, createList, resolveChain, updateBoard, deleteBoard } from "../db/operations.js";
import { exportList, exportBoard } from "../db/exportImport.js";
import type { NativeExport } from "../db/exportImport.js";
import ImportModal from "../components/ImportModal.js";
import type { ImportScope } from "../components/ImportModal.js";
import { syncClient } from "../sync/SyncClient.js";
import { assetUrls } from "../sync/assetStore.js";
import { selectedListIds, setSelectedListIds } from "../store/sidebarSelection.js";
import { appViewMode, setAppViewMode } from "../store/viewMode.js";
import { selectionMode, setSelectionMode } from "../store/selectionMode.js";
import { useSortable } from "../hooks/useSortable.js";
import ItemFormModal from "../components/ItemFormModal.js";
import MultiItemFormModal from "../components/MultiItemFormModal.js";
import ListFormModal from "../components/ListFormModal.js";
import BoardFormModal from "../components/BoardFormModal.js";
import FormattedText from "../components/FormattedText.js";
import ContextMenu from "../components/ContextMenu.js";
import type { MenuItem } from "../components/ContextMenu.js";
import MoveToListModal from "../components/MoveToListModal.js";

const VIEW_MODES: { mode: "list" | "table" | "card"; label: string }[] = [
  { mode: "list", label: "List" },
  { mode: "table", label: "Table" },
  { mode: "card", label: "Cards" },
];

const formatCellValue = (value: unknown, type: string): string => {
  if (value == null || value === "") return "\u2014";
  if (type === "boolean") return value ? "Yes" : "No";
  if (type === "duration") {
    const n = Number(value);
    const h = Math.floor(n / 60);
    const m = n % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }
  if (type === "tags" && Array.isArray(value)) return value.join(", ");
  return String(value);
};

function triggerDownload(data: NativeExport, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

const ListView: Component = () => {
  const params = useParams();
  const location = useLocation();

  // DB-subscribed state — populated by liveQuery effects below
  const [board, setBoard] = createSignal<Board | undefined>();
  const [allLists, setAllLists] = createSignal<List[]>([]);
  const [itemsByList, setItemsByList] = createSignal<Map<string, Item[]>>(new Map());
  // integration_result status aggregated per item_id: worst status across all integrations
  const [integrationStatusByItemId, setIntegrationStatusByItemId] = createSignal<Map<string, IntegrationStatus>>(new Map());

  // Item add/edit modal state
  const [addingToList, setAddingToList] = createSignal<string | null>(null); // list id receiving a new item, or null
  const [prependToList, setPrependToList] = createSignal(false);             // true = insert before first item
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();    // item open in edit modal
  const [editingList, setEditingList] = createSignal<List | undefined>();    // list open in settings modal
  const [editingBoard, setEditingBoard] = createSignal<Board | undefined>(); // board open in settings modal
  const [boardCtxMenu, setBoardCtxMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [boardImportScope, setBoardImportScope] = createSignal<ImportScope | null>(null);
  const [listCtxMenu, setListCtxMenu] = createSignal<{ x: number; y: number; list: List } | null>(null);
  const [listImportScope, setListImportScope] = createSignal<ImportScope | null>(null);

  // Selection state
  const [selectedItemIds, setSelectedItemIds] = createSignal<Set<string>>(new Set());
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null); // shift-click range anchor
  const [itemCtxMenu, setItemCtxMenu] = createSignal<{ x: number; y: number; item: Item } | null>(null);
  const [showMultiEdit, setShowMultiEdit] = createSignal(false);             // multi-edit modal open
  const [showMoveToList, setShowMoveToList] = createSignal(false);           // move-to-list picker open

  // Filter
  const [filterQuery, setFilterQuery] = createSignal("");
  const [filterOpen, setFilterOpen] = createSignal(false); // mobile: filter bar expanded

  let multiListViewEl: HTMLElement | undefined;

  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Touch interaction bookkeeping (not signals — no reactive subscribers need these)
  let lastTapItemId: string | null = null;  // for double-tap-to-edit detection
  let lastTapTime = 0;
  let lastTapListId: string | null = null;  // for double-tap list header to edit
  let lastTapListTime = 0;
  let lastContextMenuTime = 0;              // suppresses click fired after a long-press contextmenu
  let touchSelectTimer: ReturnType<typeof setTimeout> | null = null; // pending delayed selection
  let touchStartX = 0;
  let touchStartY = 0;

  const allBoards = from(liveQuery(() => db.boards.orderBy("position").toArray()));

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedItemIds(new Set<string>());
  };

  // Auto-exit selection mode when all items are deselected; clear selection when mode is exited from outside
  createEffect(() => {
    if (selectionMode() && selectedItemIds().size === 0) setSelectionMode(false);
    if (!selectionMode()) setSelectedItemIds(new Set<string>());
  });

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      exitSelectionMode();
      setItemCtxMenu(null);
    }
  };
  document.addEventListener("keydown", handleGlobalKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown));

  // Reset per-board state when navigating to a different board
  createEffect(() => {
    if (!params.id) return; // Help the type system.
    const boardId = params.id;
    setSelectedItemIds(new Set<string>());
    setSelectionMode(false);
    setItemCtxMenu(null);
    setFilterQuery("");
    setFilterOpen(false);
    setEditingList(undefined);

    const sub1 = liveQuery(() => db.boards.get(boardId)).subscribe((v) => setBoard(v));
    const sub2 = liveQuery(() =>
      db.lists.where("board_id").equals(boardId).sortBy("position")
    ).subscribe((v) => setAllLists(v));
    onCleanup(() => { sub1.unsubscribe(); sub2.unsubscribe(); });
  });

  // Watch location.state for openSettings
  createEffect(() => {
    const state = location.state as any;
    if (state?.openSettings) {
      const listId = state.openSettings as string;
      const list = allLists().find((l) => l.id === listId);
      if (list) setEditingList(list);
    }
  });

  createEffect(() => {
    const listIds = allLists().map((l) => l.id);
    if (!listIds.length) { setItemsByList(new Map()); setIntegrationStatusByItemId(new Map()); return; }
    const sub = liveQuery(async () => {
      const map = new Map<string, Item[]>();
      await Promise.all(listIds.map(async (id) => {
        const rawItems = await db.items.where("list_id").equals(id).toArray();
        map.set(id, resolveChain(rawItems)); // chain order
      }));
      return map;
    }).subscribe((v) => setItemsByList(v));
    onCleanup(() => sub.unsubscribe());
  });

  // Subscribe to integration results for items in this board
  createEffect(() => {
    const allItemIds = [...itemsByList().values()].flatMap((items) => items.map((i) => i.id));
    if (!allItemIds.length) { setIntegrationStatusByItemId(new Map()); return; }
    const STATUS_PRIORITY: IntegrationStatus[] = ["error", "ambiguous", "unprocessed", "complete"];
    const sub = liveQuery(async () => {
      const results = await db.integration_results.where("item_id").anyOf(allItemIds).toArray();
      const map = new Map<string, IntegrationStatus>();
      for (const r of results) {
        const existing = map.get(r.item_id);
        const existingPriority = existing ? STATUS_PRIORITY.indexOf(existing) : STATUS_PRIORITY.length;
        const newPriority = STATUS_PRIORITY.indexOf(r.status);
        if (newPriority < existingPriority) map.set(r.item_id, r.status);
      }
      return map;
    }).subscribe((v) => setIntegrationStatusByItemId(v ?? new Map()));
    onCleanup(() => sub.unsubscribe());
  });

  createEffect(() => {
    const [id] = selectedListIds();
    if (!id || !multiListViewEl) return;
    const col = multiListViewEl.querySelector<HTMLElement>(`[data-list-id="${id}"]`);
    col?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });

  const visibleLists = allLists;

  const headerTitle = () => board()?.name ?? "";

  const schema = createMemo((): AttributeDefinition[] => {
    const b = board();
    if (!b) return [];
    return [...b.schema].sort((a, b) => a.position - b.position);
  });

  const effectiveFormatString = createMemo(() => board()?.format_string || "{title}");

  const formatItem = (item: Item, list: List): string => {
    const urls = assetUrls();
    const fs = list.format_string || effectiveFormatString();
    return renderFormatStringHtml(fs, item, schema(), undefined, board()?.macros, (url) => urls[url] ?? url);
  };

  const integrationBadge = (itemId: string) => {
    const status = integrationStatusByItemId().get(itemId);
    if (!status || status === "complete") return null;
    if (status === "unprocessed") return <span class="integration-badge integration-badge-pending" title="Integration processing…">↻</span>;
    if (status === "error") return <span class="integration-badge integration-badge-error" title="Integration error">!</span>;
    if (status === "ambiguous") return <span class="integration-badge integration-badge-ambiguous" title="Ambiguous result — needs manual resolution">?</span>;
    return null;
  };

  const itemsForList = (listId: string): Item[] => {
    const allForList = itemsByList().get(listId) ?? [];
    const q = filterQuery().toLowerCase().trim();
    if (!q) return allForList;
    return allForList.filter((item) => {
      if (item.title.toLowerCase().includes(q)) return true;
      for (const val of Object.values(item.attributes)) {
        if (val != null && String(val).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  };

  const handleAddItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const listId = addingToList();
    if (!listId) return;
    if (prependToList()) {
      await createItem(listId, data.title, data.attributes, null); // insert at top
    } else {
      await createItem(listId, data.title, data.attributes); // append to end
    }
    setAddingToList(null);
    setPrependToList(false);
  };

  const handleEditItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const item = editingItem();
    if (!item) return;
    await updateItem(item.id, { title: data.title, attributes: data.attributes });
    setEditingItem(undefined);
  };

  const handleDeleteItem = async () => {
    const item = editingItem();
    if (!item) return;
    await deleteItem(item.id);
    setEditingItem(undefined);
  };

  const handleNewList = async () => {
    const b = board();
    if (!b) return;
    const list = await createList("New List", b.id);
    setEditingList(list);
  };

  const handleEditList = async (data: { name: string; board_id: string; format_string: string | null; integrations: Integration[] | null }) => {
    const list = editingList();
    if (!list) return;
    await updateList(list.id, { ...data, integrations: data.integrations });
    setEditingList(undefined);
  };

  const handleEditBoard = async (data: { name: string; color: string; format_string: string; schema: AttributeDefinition[]; macros: Record<string, string>; sync_key: string; integrations: Integration[] }) => {
    const b = editingBoard();
    if (!b) return;
    await updateBoard(b.id, data);
    setEditingBoard(undefined);
  };

  const boardCtxMenuItems = createMemo((): MenuItem[] => {
    const b = board();
    if (!b) return [];
    return [
      { label: "Edit", action: () => { setBoardCtxMenu(null); setEditingBoard(b); } },
      { label: "Import", action: () => { setBoardCtxMenu(null); setBoardImportScope({ type: "board", id: b.id, name: b.name, schema: b.schema, format_string: b.format_string, macros: b.macros ?? {} }); } },
      { label: "Export", action: async () => { setBoardCtxMenu(null); const data = await exportBoard(b.id); triggerDownload(data, `listr-board-${b.name}-${new Date().toISOString().slice(0, 10)}.json`); } },
      { label: "Delete", danger: true, action: async () => { setBoardCtxMenu(null); if (!confirm(`Delete "${b.name}" and all its lists and items?`)) return; await deleteBoard(b.id); } },
    ];
  });

  const handleEditFromBar = () => {
    if (selectedItemIds().size === 1) {
      const id = [...selectedItemIds()][0];
      const item = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === id);
      if (item) setEditingItem(item);
    } else {
      setShowMultiEdit(true);
    }
  };

  const handleMultiEditSave = async (attrUpdates: Record<string, unknown>) => {
    const ids = [...selectedItemIds()];
    for (const id of ids) {
      const item = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === id);
      if (!item) continue;
      await updateItem(id, { attributes: { ...item.attributes, ...attrUpdates } });
    }
    setShowMultiEdit(false);
  };

  const handleDeleteSelectedItems = async () => {
    const ids = [...selectedItemIds()];
    if (!confirm(`Delete ${ids.length} item${ids.length !== 1 ? "s" : ""}?`)) return;
    for (const id of ids) await deleteItem(id);
    setSelectedItemIds(new Set<string>());
    setItemCtxMenu(null);
  };

  const handleItemEditFromCtx = () => {
    const ctx = itemCtxMenu();
    if (ctx) { setEditingItem(ctx.item); setItemCtxMenu(null); }
  };

  const listCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = listCtxMenu();
    if (!ctx) return [];
    const { list } = ctx;
    const b = board();
    return [
      { label: "Edit", action: () => { setListCtxMenu(null); setEditingList(list); } },
      { label: "Import", action: () => { setListCtxMenu(null); b && setListImportScope({ type: "list", id: list.id, name: list.name, schema: b.schema, format_string: list.format_string ?? b.format_string, macros: b.macros ?? {} }); } },
      { label: "Export", action: async () => { setListCtxMenu(null); const data = await exportList(list.id); triggerDownload(data, `listr-list-${list.name}-${new Date().toISOString().slice(0, 10)}.json`); } },
      { label: "Delete", danger: true, action: async () => { setListCtxMenu(null); if (!confirm(`Delete "${list.name}" and all its items?`)) return; await deleteList(list.id); } },
    ];
  });

  const handleMoveToList = async (targetListId: string) => {
    setShowMoveToList(false);
    // Only move items not already in the target list — picking the same list is a no-op cancel.
    const toMove: Item[] = [];
    for (const items of itemsByList().values()) {
      for (const item of items) {
        if (selectedItemIds().has(item.id) && item.list_id !== targetListId) toMove.push(item);
      }
    }
    if (!toMove.length) return;

    const timestamp = Date.now();
    const movedIds = new Set(toMove.map((i) => i.id));
    const sourceLists = new Set(toMove.map((i) => i.list_id));

    // Append the moved items to the end of the target list's chain, in order.
    const rawTarget = await db.items.where("list_id").equals(targetListId).toArray();
    const targetChain = resolveChain(rawTarget);
    let prevId: string | null = targetChain.length > 0 ? targetChain[targetChain.length - 1].id : null;
    const targetUpdates: { item: Item; after_id: string | null }[] = [];
    for (const item of toMove) {
      targetUpdates.push({ item, after_id: prevId });
      prevId = item.id;
    }

    // Repair each source list: rebuild the chain over the items that remain so
    // no successor is left pointing at a moved-away item.
    const sourceRepairs: { id: string; after_id: string | null }[] = [];
    for (const srcId of sourceLists) {
      const rawSrc = await db.items.where("list_id").equals(srcId).toArray();
      const remaining = resolveChain(rawSrc).filter((i) => !movedIds.has(i.id));
      let p: string | null = null;
      for (const it of remaining) {
        if ((it.after_id ?? null) !== p) sourceRepairs.push({ id: it.id, after_id: p });
        p = it.id;
      }
    }

    await db.transaction("rw", db.items, async () => {
      for (const { item, after_id } of targetUpdates) {
        await db.items.update(item.id, { list_id: targetListId, after_id, updated_at: timestamp });
      }
      for (const { id, after_id } of sourceRepairs) {
        await db.items.update(id, { after_id, updated_at: timestamp });
      }
    });

    for (const { item, after_id } of targetUpdates) {
      syncClient.pushEntity("item", { ...item, list_id: targetListId, after_id, updated_at: timestamp });
    }
    for (const { id } of sourceRepairs) {
      const fresh = await db.items.get(id);
      if (fresh) syncClient.pushEntity("item", fresh);
    }
    exitSelectionMode();
  };

  const itemCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = itemCtxMenu();
    const menuItems: MenuItem[] = [];
    const n = selectedItemIds().size;
    if (ctx && n === 1 && selectedItemIds().has(ctx.item.id)) {
      menuItems.push({ label: "Edit Item", action: handleItemEditFromCtx });
    }
    if (n > 1) {
      menuItems.push({ label: `Edit ${n} items`, action: () => { setShowMultiEdit(true); setItemCtxMenu(null); } });
    }
    menuItems.push({ label: "Move to list", action: () => { setShowMoveToList(true); setItemCtxMenu(null); } });
    menuItems.push({ label: `Delete ${n} item${n !== 1 ? "s" : ""}`, danger: true, action: handleDeleteSelectedItems });
    return menuItems;
  });

  const handleItemTouchStart = (e: TouchEvent, item: Item) => {
    if (selectionMode()) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    if (touchSelectTimer) clearTimeout(touchSelectTimer);
    touchSelectTimer = setTimeout(() => {
      touchSelectTimer = null;
      setAnchorItemId(item.id);
      setSelectedItemIds(new Set([item.id]));
    }, 80);
  };

  const handleItemTouchMove = (e: TouchEvent) => {
    if (!touchSelectTimer) return;
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > 10 || dy > 10) {
      clearTimeout(touchSelectTimer);
      touchSelectTimer = null;
    }
  };

  const handleItemClick = (e: MouseEvent, item: Item, contextItems: Item[]) => {
    e.stopPropagation();

    if (isTouch) {
      if (Date.now() - lastContextMenuTime < 600) return;
      if (selectionMode()) {
        setAnchorItemId(item.id);
        setSelectedItemIds((prev) => {
          const next = new Set(prev);
          next.has(item.id) ? next.delete(item.id) : next.add(item.id);
          return next;
        });
        return;
      }
      const now = Date.now();
      if (lastTapItemId === item.id && now - lastTapTime < 350) {
        lastTapItemId = null;
        lastTapTime = 0;
        setEditingItem(item);
        return;
      }
      lastTapItemId = item.id;
      lastTapTime = now;
      return;
    }

    if (e.shiftKey && anchorItemId()) {
      const ids = contextItems.map((i) => i.id);
      const a = ids.indexOf(anchorItemId()!);
      const b = ids.indexOf(item.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const rangeIds = new Set(ids.slice(lo, hi + 1));
        if (e.ctrlKey || e.metaKey) {
          setSelectedItemIds((prev) => new Set([...prev, ...rangeIds]));
        } else {
          setSelectedItemIds(rangeIds);
        }
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchorItemId(item.id);
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        next.has(item.id) ? next.delete(item.id) : next.add(item.id);
        return next;
      });
      return;
    }
    setAnchorItemId(item.id);
    if (selectedItemIds().size === 1 && selectedItemIds().has(item.id)) {
      setSelectedItemIds(new Set<string>());
    } else {
      setSelectedItemIds(new Set([item.id]));
    }
  };

  const handleItemContextMenu = (e: MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTouch) {
      if ((e.target as Element).closest('.drag-handle')) return; // long-press on grip = drag, not edit
      lastContextMenuTime = Date.now();
      setSelectionMode(true);
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
      return;
    }
    if (!selectedItemIds().has(item.id)) {
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
    }
    setItemCtxMenu({ x: e.clientX, y: e.clientY, item });
  };

  const handleCrossListMove = async (itemId: string, toEl: HTMLElement, rawNewIndex: number) => {
    const toListId = toEl.dataset.listId;
    const offset = parseInt(toEl.dataset.indexOffset ?? "0");
    if (!toListId || !itemId) return;

    const sourceItem = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === itemId);
    if (!sourceItem || sourceItem.list_id === toListId) return;

    const timestamp = Date.now();

    // Predecessor in the target chain, from the drop index (offset skips any
    // non-item DOM children rendered before the list's items).
    const toItems = itemsByList().get(toListId) ?? []; // chain order
    const targetIndex = rawNewIndex - offset;
    const predecessorId = targetIndex > 0 ? (toItems[targetIndex - 1]?.id ?? null) : null;

    // Splice fix-ups: the target item that followed the insertion point now
    // follows the moved item; the source item that followed the moved item skips
    // over it (inherits the moved item's old predecessor).
    const targetSuccessor = toItems.find((i) => (i.after_id ?? null) === predecessorId);
    const rawSource = await db.items.where("list_id").equals(sourceItem.list_id).toArray();
    const sourceSuccessor = rawSource.find((i) => (i.after_id ?? null) === itemId && i.id !== itemId);

    await db.transaction("rw", db.items, async () => {
      await db.items.update(itemId, { list_id: toListId, after_id: predecessorId, updated_at: timestamp });
      if (sourceSuccessor) {
        await db.items.update(sourceSuccessor.id, { after_id: sourceItem.after_id ?? null, updated_at: timestamp });
      }
      if (targetSuccessor) {
        await db.items.update(targetSuccessor.id, { after_id: itemId, updated_at: timestamp });
      }
    });

    syncClient.pushEntity("item", { ...sourceItem, list_id: toListId, after_id: predecessorId, updated_at: timestamp });
    for (const s of [sourceSuccessor, targetSuccessor]) {
      if (!s) continue;
      const fresh = await db.items.get(s.id);
      if (fresh) syncClient.pushEntity("item", fresh);
    }
  };

  const totalItemCount = createMemo(() => {
    let count = 0;
    for (const list of visibleLists()) {
      count += itemsForList(list.id).length;
    }
    return count;
  });

  return (
    <div class="main">
      <Show when={board()} fallback={<div class="empty-state"><p>Board not found.</p></div>}>
        {(_cat) => (
          <>
            <Show when={selectionMode()} fallback={
              <>
                <div class="page-header">
                  <div class="page-title" onContextMenu={(e) => { e.preventDefault(); setBoardCtxMenu({ x: e.clientX, y: e.clientY }); }}>
                    <h1>{headerTitle()}</h1>
                    <span class="item-count">{totalItemCount()}</span>
                  </div>
                  <div class="header-actions">
                    <input
                      class="filter-input"
                      type="text"
                      placeholder="Filter..."
                      value={filterQuery()}
                      onInput={(e) => setFilterQuery(e.currentTarget.value)}
                    />
                    <button
                      class="filter-toggle-btn"
                      classList={{ active: filterOpen() }}
                      onClick={() => setFilterOpen((v) => !v)}
                      aria-label="Filter"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v1.5a1.5 1.5 0 0 1-.44 1.06L10 9.62V14a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 13v-3.38L1.44 5.06A1.5 1.5 0 0 1 1 4V2.5zm1.5-.5a.5.5 0 0 0-.5.5V4a.5.5 0 0 0 .15.35L7.5 9.2V13l1 .5V9.2l4.85-4.85A.5.5 0 0 0 13.5 4V2.5a.5.5 0 0 0-.5-.5h-11z"/></svg>
                    </button>
                    <div class="view-switcher" role="tablist" aria-label="View mode">
                      <For each={VIEW_MODES}>
                        {(vm) => (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={appViewMode() === vm.mode}
                            class="view-switcher-btn"
                            classList={{ active: appViewMode() === vm.mode }}
                            onClick={() => setAppViewMode(vm.mode)}
                          >
                            {vm.label}
                          </button>
                        )}
                      </For>
                    </div>
                    <select
                      class="view-switcher-select"
                      value={appViewMode()}
                      onChange={(e) => setAppViewMode(e.currentTarget.value as "list" | "table" | "card")}
                      aria-label="View mode"
                    >
                      <For each={VIEW_MODES}>
                        {(vm) => <option value={vm.mode}>{vm.label}</option>}
                      </For>
                    </select>
                  </div>
                </div>

                <Show when={filterOpen()}>
                  <div class="mobile-filter-bar">
                    <input
                      class="filter-input"
                      type="text"
                      placeholder="Filter..."
                      value={filterQuery()}
                      onInput={(e) => setFilterQuery(e.currentTarget.value)}
                      ref={(el) => setTimeout(() => el.focus(), 50)}
                    />
                    <button
                      class="mobile-filter-bar-close"
                      onClick={() => { setFilterOpen(false); setFilterQuery(""); }}
                      aria-label="Close filter"
                    >
                      ✕
                    </button>
                  </div>
                </Show>
              </>
            }>
              <div class="selection-bar">
                <button class="selection-bar-back" onClick={exitSelectionMode} aria-label="Cancel selection">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12H19M5 12L11 6M5 12L11 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                <span class="selection-bar-count">{selectedItemIds().size} selected</span>
                <button class="btn-ghost" onClick={handleEditFromBar}>Edit</button>
                <button class="btn-ghost" onClick={() => setShowMoveToList(true)}>Move</button>
                <button class="btn-danger" onClick={handleDeleteSelectedItems}>Delete</button>
              </div>
            </Show>

            <div class="multi-list-view" classList={{ "multi-list-vertical": appViewMode() !== "list" }} ref={(el) => { multiListViewEl = el; }}>
              <For each={visibleLists()}>
                {(list) => {
                  const items = () => itemsForList(list.id);
                  const allItemsForList = () => itemsByList().get(list.id) ?? [];
                  const applyOptimisticReorder = (updates: { id: string; after_id: string | null }[]) => {
                    const updatesMap = new Map(updates.map(u => [u.id, u.after_id]));
                    const newMap = new Map(itemsByList());
                    const listItems = newMap.get(list.id) ?? [];
                    newMap.set(list.id, resolveChain(
                      listItems.map(item =>
                        updatesMap.has(item.id) ? { ...item, after_id: updatesMap.get(item.id)! } : item
                      )
                    ));
                    setItemsByList(newMap);
                  };
                  return (
                    <div class="multi-list-column" data-list-id={list.id}>
                      <div
                        class="multi-list-column-header"
                        onContextMenu={(e) => { e.preventDefault(); setListCtxMenu({ x: e.clientX, y: e.clientY, list }); }}
                        onClick={() => {
                          if (isTouch) {
                            const now = Date.now();
                            if (lastTapListId === list.id && now - lastTapListTime < 350) {
                              lastTapListId = null; lastTapListTime = 0;
                              setEditingList(list);
                              return;
                            }
                            lastTapListId = list.id; lastTapListTime = now;
                          }
                          setSelectedListIds(new Set([list.id]));
                        }}
                      >
                        <span class="multi-list-column-name">{list.name}</span>
                        <span class="multi-list-column-count">{items().length}</span>
                        <button
                          class="multi-list-add-btn"
                          type="button"
                          aria-label="Add item"
                          onClick={(e) => { e.stopPropagation(); setPrependToList(true); setAddingToList(list.id); }}
                        >+</button>
                      </div>

                      <Switch>
                        <Match when={appViewMode() === "list"}>
                          <ul class="list-view multi-list-items" data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, onOptimisticReorder: applyOptimisticReorder, scrollEl: multiListViewEl })}>
                            <For each={items()}>
                              {(item) => (
                                <li
                                  class="list-view-item"
                                  data-item-id={item.id}
                                  classList={{ selected: selectedItemIds().has(item.id) }}
                                  onTouchStart={(e) => handleItemTouchStart(e, item)}
                                  onTouchMove={handleItemTouchMove}
                                  onClick={(e) => handleItemClick(e, item, items())}
                                  onDblClick={() => setEditingItem(item)}
                                  onContextMenu={(e) => handleItemContextMenu(e, item)}
                                >
                                  <Show when={selectionMode()} fallback={<span class="drag-handle" title="Drag to reorder">⠿</span>}>
                                    <input type="checkbox" class="item-select-checkbox" checked={selectedItemIds().has(item.id)} onClick={(e) => e.preventDefault()} />
                                  </Show>
                                  <FormattedText html={formatItem(item, list)} />
                                  {integrationBadge(item.id)}
                                </li>
                              )}
                            </For>
                            <li class="view-add" onClick={() => setAddingToList(list.id)}>+ Add Item</li>
                          </ul>
                        </Match>

                        <Match when={appViewMode() === "table"}>
                          <div class="table-container">
                            <table>
                              <thead>
                                <tr>
                                  <th style="width: 32px"></th>
                                  <th>Title</th>
                                  <For each={schema()}>
                                    {(attr) => <th>{attr.label || attr.key}</th>}
                                  </For>
                                </tr>
                              </thead>
                              <tbody data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, onOptimisticReorder: applyOptimisticReorder, scrollEl: multiListViewEl })}>
                                <For each={items()}>
                                  {(item) => (
                                    <tr
                                      data-item-id={item.id}
                                      classList={{ selected: selectedItemIds().has(item.id) }}
                                      onTouchStart={(e) => handleItemTouchStart(e, item)}
                                  onTouchMove={handleItemTouchMove}
                                      onClick={(e) => handleItemClick(e, item, items())}
                                      onDblClick={() => setEditingItem(item)}
                                      onContextMenu={(e) => handleItemContextMenu(e, item)}
                                    >
                                      <td class="drag-handle-cell">
                                        <Show when={selectionMode()} fallback={<span class="drag-handle" title="Drag to reorder">⠿</span>}>
                                          <input type="checkbox" class="item-select-checkbox" checked={selectedItemIds().has(item.id)} onClick={(e) => e.preventDefault()} />
                                        </Show>
                                      </td>
                                      <td style="font-weight: 500">{item.title}{integrationBadge(item.id)}</td>
                                      <For each={schema()}>
                                        {(attr) => (
                                          <td>{formatCellValue(item.attributes[attr.key], attr.type)}</td>
                                        )}
                                      </For>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                            <div class="view-add" onClick={() => setAddingToList(list.id)}>+ Add Item</div>
                          </div>
                        </Match>

                        <Match when={appViewMode() === "card"}>
                          <div class="card-container">
                            <div class="card-grid" data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, onOptimisticReorder: applyOptimisticReorder, scrollEl: multiListViewEl })}>
                              <For each={items()}>
                                {(item) => (
                                  <div
                                    class="card item"
                                    data-item-id={item.id}
                                    classList={{ selected: selectedItemIds().has(item.id) }}
                                    onTouchStart={(e) => handleItemTouchStart(e, item)}
                                  onTouchMove={handleItemTouchMove}
                                    onClick={(e) => handleItemClick(e, item, items())}
                                    onDblClick={() => setEditingItem(item)}
                                    onContextMenu={(e) => handleItemContextMenu(e, item)}
                                  >
                                    <Show when={selectionMode()} fallback={<span class="drag-handle card-drag-handle" title="Drag to reorder">⠿</span>}>
                                      <input type="checkbox" class="card-select-checkbox" checked={selectedItemIds().has(item.id)} onClick={(e) => e.preventDefault()} />
                                    </Show>
                                    <div class="card-title"><FormattedText html={formatItem(item, list)} />{integrationBadge(item.id)}</div>
                                    <Show when={schema().length > 0}>
                                      <div class="card-attrs">
                                        <For each={schema()}>
                                          {(attr) => {
                                            const val = item.attributes[attr.key];
                                            if (val == null || val === "") return null;
                                            return (
                                              <div class="card-attr">
                                                <span class="card-attr-label">{attr.label || attr.key}</span>
                                                <Show
                                                  when={attr.type === "tags" && Array.isArray(val)}
                                                  fallback={<span>{formatCellValue(val, attr.type)}</span>}
                                                >
                                                  <span>
                                                    <For each={val as string[]}>
                                                      {(t) => <span class="tag">{t}</span>}
                                                    </For>
                                                  </span>
                                                </Show>
                                              </div>
                                            );
                                          }}
                                        </For>
                                      </div>
                                    </Show>
                                  </div>
                                )}
                              </For>
                              <div class="card add" onClick={() => setAddingToList(list.id)}>+ Add Item</div>
                            </div>
                          </div>
                        </Match>
                      </Switch>
                    </div>
                  );
                }}
              </For>
              <div class="multi-list-new-column" onClick={handleNewList}>
                + New list
              </div>
            </div>

            <Show when={boardCtxMenu() !== null}>
              {(_) => {
                const pos = () => boardCtxMenu()!;
                return (
                  <ContextMenu x={pos().x} y={pos().y} items={boardCtxMenuItems()} onClose={() => setBoardCtxMenu(null)} />
                );
              }}
            </Show>

            <Show when={boardImportScope()}>
              {(scope) => <ImportModal open={true} onClose={() => setBoardImportScope(null)} scope={scope()} />}
            </Show>

            <Show when={listCtxMenu() !== null}>
              {(_) => {
                const pos = () => listCtxMenu()!;
                return (
                  <ContextMenu x={pos().x} y={pos().y} items={listCtxMenuItems()} onClose={() => setListCtxMenu(null)} />
                );
              }}
            </Show>

            <Show when={listImportScope()}>
              {(scope) => <ImportModal open={true} onClose={() => setListImportScope(null)} scope={scope()} />}
            </Show>

            <Show when={itemCtxMenu() !== null}>
              {(_) => {
                const pos = () => itemCtxMenu()!;
                return (
                  <ContextMenu
                    x={pos().x}
                    y={pos().y}
                    items={itemCtxMenuItems()}
                    onClose={() => setItemCtxMenu(null)}
                  />
                );
              }}
            </Show>

            <ItemFormModal
              open={addingToList() !== null}
              onClose={() => { setAddingToList(null); setPrependToList(false); }}
              onSave={handleAddItem}
              schema={schema()}
            />

            <MultiItemFormModal
              open={showMultiEdit()}
              onClose={() => setShowMultiEdit(false)}
              onSave={handleMultiEditSave}
              schema={schema()}
              count={selectedItemIds().size}
            />

            <ItemFormModal
              open={editingItem() !== undefined}
              onClose={() => setEditingItem(undefined)}
              onSave={handleEditItem}
              onDelete={handleDeleteItem}
              schema={schema()}
              initial={editingItem()}
            />

            <ListFormModal
              open={editingList() !== undefined}
              onClose={() => setEditingList(undefined)}
              onSave={handleEditList}
              boards={allBoards() ?? []}
              initial={editingList()}
            />

            <BoardFormModal
              open={editingBoard() !== undefined}
              onClose={() => setEditingBoard(undefined)}
              onSave={handleEditBoard}
              initial={editingBoard()}
            />

            <BoardFormModal
              open={editingBoard() !== undefined}
              onClose={() => setEditingBoard(undefined)}
              onSave={handleEditBoard}
              initial={editingBoard()}
            />

            <MoveToListModal
              open={showMoveToList()}
              onClose={() => setShowMoveToList(false)}
              onSelect={handleMoveToList}
              currentBoardId={board()?.id}
            />
          </>
        )}
      </Show>
    </div>
  );
};

export default ListView;
