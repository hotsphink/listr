import { type Component, For, Show, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { useParams, useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { renderFormatStringHtml } from "@listr/shared";
import type { AttributeDefinition, Category, Item, List, ViewMode } from "@listr/shared";
import { db } from "../db/database.js";
import { createItem, updateItem, deleteItem, updateList } from "../db/operations.js";
import { assetUrls } from "../sync/assetStore.js";
import { selectedListIds } from "../store/sidebarSelection.js";
import ItemFormModal from "../components/ItemFormModal.js";
import FormattedText from "../components/FormattedText.js";

const CategoryView: Component = () => {
  const params = useParams();
  const navigate = useNavigate();

  const [category, setCategory] = createSignal<Category | undefined>();
  const [allLists, setAllLists] = createSignal<List[]>([]);
  const [itemsByList, setItemsByList] = createSignal<Map<string, Item[]>>(new Map());
  const [addingToList, setAddingToList] = createSignal<string | null>(null);
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();

  createEffect(() => {
    const catId = params.id;
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
    await createItem(listId, data.title, data.attributes);
    setAddingToList(null);
  };

  const handleEditItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const item = editingItem();
    if (!item) return;
    await updateItem(item.id, { title: data.title, attributes: data.attributes });
    setEditingItem(undefined);
  };

  const goToListView = async (mode: ViewMode) => {
    const list = visibleLists()[0];
    if (!list) return;
    await updateList(list.id, { view_mode: mode });
    navigate(`/list/${list.id}`);
  };

  const handleDeleteItem = async () => {
    const item = editingItem();
    if (!item) return;
    await deleteItem(item.id);
    setEditingItem(undefined);
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
                        onDblClick={() => navigate(`/list/${list.id}`)}
                        title="Double-click to open list"
                      >
                        <span class="multi-list-column-name">{list.name}</span>
                        <span class="multi-list-column-count">{items().length}</span>
                      </div>
                      <ul class="list-view multi-list-items">
                        <For each={items()}>
                          {(item) => (
                            <li
                              class="list-view-item"
                              onDblClick={() => setEditingItem(item)}
                            >
                              <FormattedText html={formatItem(item, list)} />
                            </li>
                          )}
                        </For>
                        <li class="view-add" onClick={() => setAddingToList(list.id)}>
                          + Add Item
                        </li>
                      </ul>
                    </div>
                  );
                }}
              </For>
            </div>

            <ItemFormModal
              open={addingToList() !== null}
              onClose={() => setAddingToList(null)}
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
