import { type Component, For, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { renderFormatStringHtml } from "@listr/shared";
import type { AttributeDefinition, Category, Item, List, ViewMode } from "@listr/shared";
import { db } from "../db/database.js";
import { createItem, updateItem, deleteItem, updateList } from "../db/operations.js";
import { assetUrls } from "../sync/assetStore.js";
import { selectedListIds } from "../store/sidebarSelection.js";
import { useSortable } from "../hooks/useSortable.js";
import ItemFormModal from "../components/ItemFormModal.js";
import FormattedText from "../components/FormattedText.js";
import ContextMenu from "../components/ContextMenu.js";
import type { MenuItem } from "../components/ContextMenu.js";

const CategoryView: Component = () => {
  const params = useParams();
  const navigate = useNavigate();

  const [category, setCategory] = createSignal<Category | undefined>();
  const [allLists, setAllLists] = createSignal<List[]>([]);
  const [itemsByList, setItemsByList] = createSignal<Map<string, Item[]>>(new Map());
  const [addingToList, setAddingToList] = createSignal<string | null>(null);
  const [prependToList, setPrependToList] = createSignal(false);
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();
  const [selectedItemIds, setSelectedItemIds] = createSignal<Set<string>>(new Set());
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null);
  const [itemCtxMenu, setItemCtxMenu] = createSignal<{ x: number; y: number; item: Item } | null>(null);

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { setSelectedItemIds(new Set()); setItemCtxMenu(null); }
  };
  document.addEventListener("keydown", handleGlobalKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown));

  createEffect(() => {
    const catId = params.id;
    setSelectedItemIds(new Set());
    setItemCtxMenu(null);
    const sub1 = liveQuery(() => db.categories.get(catId)).subscribe((v) => setCategory(v));
    const sub2 = liveQuery(() =>
      db.lists.where("category_id").equals(catId).sortBy("position")
    ).subscribe((v) => setAllLists(v));
    onCleanup(() => { sub1.unsubscribe(); sub2.unsubscribe(); });
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

  const visibleLists = createMemo(() => {
    const sel = selectedListIds();
    const all = allLists();
    if (sel.size === 0) return all;
    const catFiltered = all.filter((l) => sel.has(l.id));
    return catFiltered.length > 0 ? catFiltered : all;
  });

  const schema = createMemo((): AttributeDefinition[] => {
    const cat = category();
    if (!cat) return [];
    return [...cat.schema].sort((a, b) => a.position - b.position);
  });

  const effectiveFormatString = createMemo(() => category()?.format_string || "{title}");

  const formatItem = (item: Item, list: List): string => {
    const urls = assetUrls();
    const fs = list.format_string || effectiveFormatString();
    return renderFormatStringHtml(fs, item, schema(), undefined, category()?.macros, (url) => urls[url] ?? url);
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

  const handleDeleteSelectedItems = async () => {
    const ids = [...selectedItemIds()];
    if (!confirm(`Delete ${ids.length} item${ids.length !== 1 ? "s" : ""}?`)) return;
    for (const id of ids) await deleteItem(id);
    setSelectedItemIds(new Set());
    setItemCtxMenu(null);
  };

  const handleItemEditFromCtx = () => {
    const ctx = itemCtxMenu();
    if (ctx) { setEditingItem(ctx.item); setItemCtxMenu(null); }
  };

  const itemCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = itemCtxMenu();
    const items: MenuItem[] = [];
    if (ctx && selectedItemIds().size === 1 && selectedItemIds().has(ctx.item.id)) {
      items.push({ label: "Edit Item", action: handleItemEditFromCtx });
    }
    const n = selectedItemIds().size;
    items.push({ label: `Delete ${n} item${n !== 1 ? "s" : ""}`, danger: true, action: handleDeleteSelectedItems });
    return items;
  });

  const handleItemClick = (e: MouseEvent, item: Item, contextItems: Item[]) => {
    e.stopPropagation();
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
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set([item.id]));
    }
  };

  const handleItemContextMenu = (e: MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedItemIds().has(item.id)) {
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
    }
    setItemCtxMenu({ x: e.clientX, y: e.clientY, item });
  };

  const handleDeleteItem = async () => {
    const item = editingItem();
    if (!item) return;
    await deleteItem(item.id);
    setEditingItem(undefined);
  };

  const goToListView = async (mode: ViewMode) => {
    const list = visibleLists()[0];
    if (!list) return;
    await updateList(list.id, { view_mode: mode });
    navigate(`/list/${list.id}`);
  };

  return (
    <div class="main">
      <Show when={category()} fallback={<div class="empty-state"><p>Category not found.</p></div>}>
        {(cat) => (
          <>
            <div class="page-header">
              <div class="page-title">
                <h1>{cat().name}</h1>
                <span class="item-count">{visibleLists().length} lists</span>
              </div>
              <Show when={selectedListIds().size === 1 && visibleLists().length === 1}>
                <div class="header-actions">
                  <div class="view-switcher" role="tablist" aria-label="View mode">
                    <button type="button" role="tab" class="view-switcher-btn active">List</button>
                    <button type="button" role="tab" class="view-switcher-btn" onClick={() => goToListView("table")}>Table</button>
                    <button type="button" role="tab" class="view-switcher-btn" onClick={() => goToListView("card")}>Cards</button>
                    <button type="button" role="tab" class="view-switcher-btn" onClick={() => goToListView("board")}>Board</button>
                  </div>
                </div>
              </Show>
            </div>

            <div class="multi-list-view">
              <For each={visibleLists()}>
                {(list) => {
                  const items = () => itemsByList().get(list.id) ?? [];
                  return (
                    <div class="multi-list-column">
                      <div
                        class="multi-list-column-header"
                        title="Double-click to open list"
                        onDblClick={() => navigate(`/list/${list.id}`)}
                      >
                        <span class="multi-list-column-name">{list.name}</span>
                        <span class="multi-list-column-count">{items().length}</span>
                      </div>
                      <ul class="list-view multi-list-items" ref={(el) => useSortable(el, items, { indexOffset: 1 })}>
                        <li class="view-add" onClick={() => { setPrependToList(true); setAddingToList(list.id); }}>+ Add Item</li>
                        <For each={items()}>
                          {(item) => (
                            <li
                              class="list-view-item"
                              classList={{ selected: selectedItemIds().has(item.id) }}
                              onClick={(e) => handleItemClick(e, item, items())}
                              onDblClick={() => setEditingItem(item)}
                              onContextMenu={(e) => handleItemContextMenu(e, item)}
                            >
                              <span class="drag-handle" title="Drag to reorder">⠿</span>
                              <FormattedText html={formatItem(item, list)} />
                            </li>
                          )}
                        </For>
                        <li class="view-add" onClick={() => setAddingToList(list.id)}>+ Add Item</li>
                      </ul>
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

            <ItemFormModal
              open={editingItem() !== undefined}
              onClose={() => setEditingItem(undefined)}
              onSave={handleEditItem}
              onDelete={handleDeleteItem}
              schema={schema()}
              initial={editingItem()}
            />
          </>
        )}
      </Show>
    </div>
  );
};

export default CategoryView;
