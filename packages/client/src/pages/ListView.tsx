import { type Component, For, Show, Switch, Match, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { from } from "solid-js";
import { useParams, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { renderFormatStringHtml } from "@listr/shared";
import type { AttributeDefinition, Board, Item, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createItem, updateItem, deleteItem, updateList } from "../db/operations.js";
import { syncClient } from "../sync/SyncClient.js";
import { assetUrls } from "../sync/assetStore.js";
import { selectedListIds, setSelectedListIds } from "../store/sidebarSelection.js";
import { appViewMode, setAppViewMode } from "../store/viewMode.js";
import { selectionMode, setSelectionMode } from "../store/selectionMode.js";
import { useSortable } from "../hooks/useSortable.js";
import ItemFormModal from "../components/ItemFormModal.js";
import MultiItemFormModal from "../components/MultiItemFormModal.js";
import ListFormModal from "../components/ListFormModal.js";
import FormattedText from "../components/FormattedText.js";
import ContextMenu from "../components/ContextMenu.js";
import type { MenuItem } from "../components/ContextMenu.js";

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

const ListView: Component = () => {
  const params = useParams();
  const location = useLocation();

  // DB-subscribed state — populated by liveQuery effects below
  const [board, setBoard] = createSignal<Board | undefined>();
  const [allLists, setAllLists] = createSignal<List[]>([]);
  const [itemsByList, setItemsByList] = createSignal<Map<string, Item[]>>(new Map());

  // Item add/edit modal state
  const [addingToList, setAddingToList] = createSignal<string | null>(null); // list id receiving a new item, or null
  const [prependToList, setPrependToList] = createSignal(false);             // true = insert before first item
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();    // item open in edit modal
  const [editingList, setEditingList] = createSignal<List | undefined>();    // list open in settings modal

  // Selection state
  const [selectedItemIds, setSelectedItemIds] = createSignal<Set<string>>(new Set());
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null); // shift-click range anchor
  const [itemCtxMenu, setItemCtxMenu] = createSignal<{ x: number; y: number; item: Item } | null>(null);
  const [showMultiEdit, setShowMultiEdit] = createSignal(false);             // multi-edit modal open

  // Filter
  const [filterQuery, setFilterQuery] = createSignal("");
  const [filterOpen, setFilterOpen] = createSignal(false); // mobile: filter bar expanded

  let multiListViewEl: HTMLElement | undefined;

  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Touch interaction bookkeeping (not signals — no reactive subscribers need these)
  let lastTapItemId: string | null = null;  // for double-tap-to-edit detection
  let lastTapTime = 0;
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
    if (!listIds.length) { setItemsByList(new Map()); return; }
    const sub = liveQuery(async () => {
      const map = new Map<string, Item[]>();
      await Promise.all(listIds.map(async (id) => {
        const items = await db.items.where("list_id").equals(id).sortBy("position");
        map.set(id, items);
      }));
      return map;
    }).subscribe((v) => setItemsByList(v));
    onCleanup(() => sub.unsubscribe());
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
      const items = itemsByList().get(listId) ?? [];
      const minPos = items.length > 0 ? Math.min(...items.map((i) => i.position)) - 1 : 0;
      await createItem(listId, data.title, data.attributes, minPos);
    } else {
      await createItem(listId, data.title, data.attributes);
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

  const handleEditList = async (data: { name: string; board_id: string; format_string: string | null }) => {
    const list = editingList();
    if (!list) return;
    await updateList(list.id, data);
    setEditingList(undefined);
  };

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
    const toItems = itemsByList().get(toListId) ?? [];
    const toIndex = rawNewIndex - offset;
    let newPosition: number;
    if (toItems.length === 0) {
      newPosition = 0;
    } else if (toIndex <= 0) {
      newPosition = toItems[0].position - 1;
    } else if (toIndex >= toItems.length) {
      newPosition = toItems[toItems.length - 1].position + 1;
    } else {
      newPosition = (toItems[toIndex - 1].position + toItems[toIndex].position) / 2;
    }
    const timestamp = Date.now();
    await db.items.update(itemId, { list_id: toListId, position: newPosition, updated_at: timestamp });
    const sourceItem = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === itemId);
    if (sourceItem) {
      syncClient.pushEntity("item", { ...sourceItem, list_id: toListId, position: newPosition, updated_at: timestamp });
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
                  <div class="page-title">
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
                <button class="btn-danger" onClick={handleDeleteSelectedItems}>Delete</button>
              </div>
            </Show>

            <div class="multi-list-view" classList={{ "multi-list-vertical": appViewMode() !== "list" }} ref={(el) => { multiListViewEl = el; }}>
              <For each={visibleLists()}>
                {(list) => {
                  const items = () => itemsForList(list.id);
                  const allItemsForList = () => itemsByList().get(list.id) ?? [];
                  return (
                    <div class="multi-list-column">
                      <div
                        class="multi-list-column-header"
                        onClick={() => setSelectedListIds(new Set([list.id]))}
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
                          <ul class="list-view multi-list-items" data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, scrollEl: multiListViewEl })}>
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
                              <tbody data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, scrollEl: multiListViewEl })}>
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
                                      <td style="font-weight: 500">{item.title}</td>
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
                            <div class="card-grid" data-list-id={list.id} data-index-offset="0" ref={(el) => useSortable(el, allItemsForList, { group: params.id, onCrossMove: handleCrossListMove, scrollEl: multiListViewEl })}>
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
                                    <div class="card-title"><FormattedText html={formatItem(item, list)} /></div>
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
            </div>

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
          </>
        )}
      </Show>
    </div>
  );
};

export default ListView;
