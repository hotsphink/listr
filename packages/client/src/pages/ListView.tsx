import { type Component, For, Show, createSignal, createEffect, createMemo, Switch, Match, onCleanup } from "solid-js";
import { useParams, useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import { renderFormatStringHtml } from "@listr/shared";
import type { AttributeDefinition, Category, Item, List, ViewMode } from "@listr/shared";
import { db } from "../db/database.js";
import {
  createItem,
  updateItem,
  deleteItem,
  updateList,
  deleteList,
} from "../db/operations.js";
import { assetUrls } from "../sync/assetStore.js";
import { useSortable } from "../hooks/useSortable.js";
import ItemFormModal from "../components/ItemFormModal.js";
import ListFormModal from "../components/ListFormModal.js";
import FormattedText from "../components/FormattedText.js";

const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: "list", label: "List" },
  { mode: "table", label: "Table" },
  { mode: "card", label: "Cards" },
  { mode: "board", label: "Board" },
];

const ListView: Component = () => {
  const params = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [showAddItem, setShowAddItem] = createSignal(false);
  const [editingItem, setEditingItem] = createSignal<Item | undefined>();
  const [showEditList, setShowEditList] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [searchOpen, setSearchOpen] = createSignal(false);

  createEffect(() => {
    if ((location.state as any)?.openSettings) {
      setShowEditList(true);
      navigate(location.pathname, { replace: true });
    }
  });

  const [list, setList] = createSignal<List | undefined>();
  const [allItems, setAllItems] = createSignal<Item[]>([]);
  const [category, setCategory] = createSignal<Category | undefined>();
  const allCategories = from(liveQuery(() => db.categories.orderBy("position").toArray()));

  createEffect(() => {
    const id = params.id;
    setEditingItem(undefined);
    setSearchQuery("");
    setSearchOpen(false);
    const sub1 = liveQuery(() => db.lists.get(id)).subscribe((v) => setList(v));
    const sub2 = liveQuery(() => db.items.where("list_id").equals(id).sortBy("position")).subscribe((v) => setAllItems(v));
    onCleanup(() => { sub1.unsubscribe(); sub2.unsubscribe(); });
  });

  createEffect(() => {
    const l = list();
    if (l?.category_id) {
      const sub = liveQuery(() => db.categories.get(l.category_id!)).subscribe((v) => setCategory(v));
      onCleanup(() => sub.unsubscribe());
    } else {
      setCategory(undefined);
    }
  });

  const schema = createMemo((): AttributeDefinition[] => {
    const cat = category();
    if (!cat) return [];
    return [...cat.schema].sort((a, b) => a.position - b.position);
  });

  const effectiveFormatString = createMemo(() => {
    const l = list();
    const cat = category();
    return l?.format_string || cat?.format_string || "{title}";
  });

  const viewMode = createMemo(() => list()?.view_mode ?? "list");

  const setViewMode = async (mode: ViewMode) => {
    await updateList(params.id, { view_mode: mode });
  };

  const items = createMemo(() => {
    const q = searchQuery().toLowerCase().trim();
    if (!q) return allItems();
    return allItems().filter((item) => {
      if (item.title.toLowerCase().includes(q)) return true;
      for (const val of Object.values(item.attributes)) {
        if (val != null && String(val).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  });

  const handleAddItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    await createItem(params.id, data.title, data.attributes);
    setShowAddItem(false);
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

  const handleEditList = async (data: { name: string; category_id: string; format_string: string | null }) => {
    await updateList(params.id, data);
    setShowEditList(false);
  };

  const formatItem = (item: Item): string => {
    const urls = assetUrls();
    return renderFormatStringHtml(effectiveFormatString(), item, schema(), undefined, category()?.macros, (url) => urls[url] ?? url);
  };

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

  const initSortable = (el: HTMLElement) => {
    useSortable(el, () => items());
  };

  // Board view helpers
  const boardGroupAttr = createMemo(() => {
    return schema().find((a) => a.type === "enum");
  });

  const boardColumns = createMemo(() => {
    const attr = boardGroupAttr();
    if (!attr) return [];
    const cols = (attr.options ?? []).map((opt) => ({
      value: opt,
      items: items().filter((item) => item.attributes[attr.key] === opt),
    }));
    cols.push({
      value: "",
      items: items().filter((item) => {
        const v = item.attributes[attr?.key ?? ""];
        return v == null || v === "" || !(attr?.options ?? []).includes(v as string);
      }),
    });
    return cols;
  });

  return (
    <div class="main">
      <Show when={list()} fallback={<div class="empty-state"><p>List not found.</p></div>}>
        {(l) => (
          <>
            <div class="page-header">
              <h1>{l().name}</h1>
              <div class="header-actions">
                <input
                  class="search-input"
                  type="text"
                  placeholder="Search..."
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                />
                <button
                  class="search-toggle-btn"
                  classList={{ active: searchOpen() }}
                  onClick={() => setSearchOpen((v) => !v)}
                  aria-label="Search"
                >
                  🔍
                </button>
                <div class="view-switcher" role="tablist" aria-label="View mode">
                  <For each={VIEW_MODES}>
                    {(vm) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={viewMode() === vm.mode}
                        class="view-switcher-btn"
                        classList={{ active: viewMode() === vm.mode }}
                        onClick={() => setViewMode(vm.mode)}
                      >
                        {vm.label}
                      </button>
                    )}
                  </For>
                </div>
                <select
                  class="view-switcher-select"
                  value={viewMode()}
                  onChange={(e) => setViewMode(e.currentTarget.value as ViewMode)}
                  aria-label="View mode"
                >
                  <For each={VIEW_MODES}>
                    {(vm) => <option value={vm.mode}>{vm.label}</option>}
                  </For>
                </select>
              </div>
            </div>
            <Show when={searchOpen()}>
              <div class="mobile-search-bar">
                <input
                  class="search-input"
                  type="text"
                  placeholder="Search..."
                  value={searchQuery()}
                  onInput={(e) => setSearchQuery(e.currentTarget.value)}
                  ref={(el) => setTimeout(() => el.focus(), 50)}
                />
                <button
                  class="mobile-search-bar-close"
                  onClick={() => { setSearchOpen(false); setSearchQuery(""); }}
                  aria-label="Close search"
                >
                  ✕
                </button>
              </div>
            </Show>

              <Switch>
                <Match when={viewMode() === "list"}>
                  <div class="list-view-container">
                    <ul class="list-view" ref={(el) => initSortable(el)}>
                      <For each={items()}>
                        {(item) => (
                          <li class="list-view-item" onClick={() => setEditingItem(item)}>
                            <span class="drag-handle" title="Drag to reorder">⠿</span>
                            <FormattedText html={formatItem(item)} />
                          </li>
                        )}
                      </For>
                      <li class="view-add" onClick={() => setShowAddItem(true)}>+ Add Item</li>
                    </ul>
                  </div>
                </Match>

                <Match when={viewMode() === "table"}>
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
                      <tbody ref={(el) => initSortable(el)}>
                        <For each={items()}>
                          {(item) => (
                            <tr onClick={() => setEditingItem(item)}>
                              <td class="drag-handle-cell"><span class="drag-handle" title="Drag to reorder">⠿</span></td>
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
                    <div class="view-add" onClick={() => setShowAddItem(true)}>+ Add Item</div>
                  </div>
                </Match>

                <Match when={viewMode() === "card"}>
                  <div class="card-container">
                    <div class="card-grid" ref={(el) => initSortable(el)}>
                      <For each={items()}>
                        {(item) => (
                          <div class="card item" onClick={() => setEditingItem(item)}>
                            <span class="drag-handle card-drag-handle" title="Drag to reorder">⠿</span>
                            <div class="card-title"><FormattedText html={formatItem(item)} /></div>
                            <Show when={schema().length > 0}>
                              <div class="card-attrs">
                                <For each={schema()}>
                                  {(attr) => {
                                    const val = item.attributes[attr.key];
                                    if (val == null || val === "") return null;
                                    return (
                                      <div class="card-attr">
                                        <span class="card-attr-label">{attr.label || attr.key}</span>
                                        <Show when={attr.type === "tags" && Array.isArray(val)}
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
                      <div class="card add" onClick={() => setShowAddItem(true)}>+ Add Item</div>
                    </div>
                  </div>
                </Match>

                <Match when={viewMode() === "board"}>
                  <div class="board-container">
                    <Show
                      when={boardGroupAttr()}
                      fallback={
                        <div class="empty-state">
                          <p>Board view requires a Select attribute to group by.</p>
                          <p style="font-size: 13px; color: var(--text-dim)">
                            Add a Select attribute to the category to use board view.
                          </p>
                        </div>
                      }
                    >
                      {(groupAttr) => (
                        <>
                          <div style="padding: 8px 24px 0; font-size: 12px; color: var(--text-muted)">
                            Grouped by: {groupAttr().label || groupAttr().key}
                          </div>
                          <div class="board-columns">
                            <For each={boardColumns()}>
                              {(col) => (
                                <div class="board-column">
                                  <div class="board-column-header">
                                    {col.value || "Unset"}
                                    <span class="board-column-count">{col.items.length}</span>
                                  </div>
                                  <div class="board-column-items">
                                    <For each={col.items}>
                                      {(item) => (
                                        <div class="board-item" onClick={() => setEditingItem(item)}>
                                          <FormattedText html={formatItem(item)} />
                                        </div>
                                      )}
                                    </For>
                                    <div class="board-add" onClick={() => setShowAddItem(true)}>+</div>
                                  </div>
                                </div>
                              )}
                            </For>
                          </div>
                        </>
                      )}
                    </Show>
                  </div>
                </Match>
              </Switch>

            <ItemFormModal
              open={showAddItem()}
              onClose={() => setShowAddItem(false)}
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

            <ListFormModal
              open={showEditList()}
              onClose={() => setShowEditList(false)}
              onSave={handleEditList}
              categories={allCategories() ?? []}
              initial={l()}
            />
          </>
        )}
      </Show>
    </div>
  );
};

export default ListView;
