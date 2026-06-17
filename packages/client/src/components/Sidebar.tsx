import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Category, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createList, createCategory, updateList, deleteList, updateCategory, deleteCategory } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";
import CategoryFormModal from "./CategoryFormModal.js";
import SyncSettingsModal from "./SyncSettingsModal.js";
import ImportModal, { type ImportScope } from "./ImportModal.js";
import { syncStatus } from "../sync/syncStore.js";
import { selectedListIds, setSelectedListIds } from "../store/sidebarSelection.js";

interface Props {
  open?: boolean;
  onClose?: () => void;
}

const Sidebar: Component<Props> = (props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const categories = from(liveQuery(() => db.categories.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));
  const itemCounts = from(liveQuery(async () => {
    const allLists = await db.lists.toArray();
    const entries = await Promise.all(
      allLists.map(async (l) => [l.id, await db.items.where("list_id").equals(l.id).count()] as const)
    );
    return new Map<string, number>(entries);
  }));

  const itemCountForList = (listId: string) => itemCounts()?.get(listId) ?? 0;

  const [expandedCategoryId, setExpandedCategoryId] = createSignal<string | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; target: { kind: "list"; list: List } | { kind: "category"; category: Category } } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [editingCategory, setEditingCategory] = createSignal<Category | undefined>();
  const [showCreateCategory, setShowCreateCategory] = createSignal(false);
  const [showSync, setShowSync] = createSignal(false);
  const [importScope, setImportScope] = createSignal<ImportScope | null>(null);
  const [anchorListId, setAnchorListId] = createSignal<string | null>(null);
  const [multiListCtxMenu, setMultiListCtxMenu] = createSignal<{ x: number; y: number } | null>(null);

  // Auto-expand the category containing the active list; auto-close sidebar on mobile
  createEffect(() => {
    const path = location.pathname;
    const listMatch = path.match(/^\/list\/(.+)/);
    if (listMatch) {
      const list = (lists() ?? []).find((l) => l.id === listMatch[1]);
      if (list) setExpandedCategoryId(list.category_id);
    }
    props.onClose?.();
  });

  const listsForCategory = (catId: string) =>
    (lists() ?? []).filter((l) => l.category_id === catId);

  const toggleCategory = (catId: string) => {
    setExpandedCategoryId((prev) => (prev === catId ? null : catId));
  };

  const handleContextMenu = (e: MouseEvent, target: { kind: "list"; list: List } | { kind: "category"; category: Category }) => {
    e.preventDefault();
    if (target.kind === "list" && selectedListIds().size > 1 && selectedListIds().has(target.list.id)) {
      setMultiListCtxMenu({ x: e.clientX, y: e.clientY });
      return;
    }
    if (target.kind === "list") setSelectedListIds(new Set([target.list.id]));
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  };

  const menuItems = (): MenuItem[] => {
    const ctx = contextMenu();
    if (!ctx) return [];

    if (ctx.target.kind === "list") {
      const list = ctx.target.list;
      const cat = (categories() ?? []).find((c) => c.id === list.category_id);
      return [
        { label: "Rename", action: () => setRenamingId(list.id) },
        { label: "Configure", action: () => navigate(`/list/${list.id}`, { state: { openSettings: true } }) },
        { label: "Import", action: () => cat && setImportScope({
            type: "list",
            id: list.id,
            name: list.name,
            schema: cat.schema,
            format_string: list.format_string ?? cat.format_string,
            macros: cat.macros ?? {},
          })
        },
        { label: "Delete", danger: true, action: async () => {
          if (!confirm(`Delete "${list.name}" and all its items?`)) return;
          await deleteList(list.id);
          if (location.pathname === `/list/${list.id}`) navigate("/");
        }},
      ];
    } else {
      const cat = ctx.target.category;
      return [
        { label: "Rename", action: () => setRenamingId(cat.id) },
        { label: "Configure", action: () => setEditingCategory(cat) },
        { label: "Import", action: () => setImportScope({
            type: "category",
            id: cat.id,
            name: cat.name,
            schema: cat.schema,
            format_string: cat.format_string,
            macros: cat.macros ?? {},
          })
        },
        { label: "Delete", danger: true, action: async () => {
          const listCount = listsForCategory(cat.id).length;
          const msg = listCount > 0
            ? `Delete "${cat.name}" and its ${listCount} list${listCount > 1 ? "s" : ""} with all items?`
            : `Delete category "${cat.name}"?`;
          if (!confirm(msg)) return;
          await deleteCategory(cat.id);
          navigate("/");
        }},
      ];
    }
  };

  const handleRenameBlur = async (id: string, newName: string, kind: "list" | "category") => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (kind === "list") {
      await updateList(id, { name: trimmed });
    } else {
      await updateCategory(id, { name: trimmed });
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

  const handleListClick = (e: MouseEvent, list: List) => {
    if (e.shiftKey && anchorListId()) {
      const catLists = listsForCategory(list.category_id);
      const ids = catLists.map((l) => l.id);
      const a = ids.indexOf(anchorListId()!);
      const b = ids.indexOf(list.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const rangeIds = new Set(ids.slice(lo, hi + 1));
        if (e.ctrlKey || e.metaKey) {
          setSelectedListIds((prev) => new Set([...prev, ...rangeIds]));
        } else {
          setSelectedListIds(rangeIds);
        }
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchorListId(list.id);
      setSelectedListIds((prev) => {
        const next = new Set(prev);
        next.has(list.id) ? next.delete(list.id) : next.add(list.id);
        return next;
      });
      return;
    }
    setAnchorListId(list.id);
    setSelectedListIds(new Set([list.id]));
    navigate(`/list/${list.id}`);
  };

  const deleteSelectedLists = async () => {
    const ids = [...selectedListIds()];
    if (!confirm(`Delete ${ids.length} list${ids.length !== 1 ? "s" : ""} and all their items?`)) return;
    for (const id of ids) {
      await deleteList(id);
      if (location.pathname === `/list/${id}`) navigate("/");
    }
    setSelectedListIds(new Set<string>());
    setMultiListCtxMenu(null);
  };

  const handleNewList = async (catId: string) => {
    const list = await createList("New List", catId);
    setRenamingId(list.id);
    navigate(`/list/${list.id}`);
  };

  return (
    <nav class="sidebar" classList={{ open: props.open ?? false }}>
      <div
        class="sidebar-header"
        style="cursor: pointer"
        onClick={() => navigate("/")}
      >
        Listr
      </div>
      <div class="sidebar-content">
        <For each={categories() ?? []}>
          {(cat) => {
            const isExpanded = () => expandedCategoryId() === cat.id;
            return (
              <div class="sidebar-category">
                <Show
                  when={renamingId() === cat.id}
                  fallback={
                    <div
                      class="sidebar-category-header"
                      classList={{ expanded: isExpanded() }}
                      style={`border-left: 3px solid ${cat.color}`}
                      onClick={() => { navigate(`/category/${cat.id}`); toggleCategory(cat.id); }}
                      onContextMenu={(e) => handleContextMenu(e, { kind: "category", category: cat })}
                    >
                      <span class="sidebar-category-chevron">{isExpanded() ? "▾" : "▸"}</span>
                      {cat.name}
                      <span class="sidebar-category-count">{listsForCategory(cat.id).length}</span>
                    </div>
                  }
                >
                  <div class="sidebar-category-header" style={`border-left: 3px solid ${cat.color}`}>
                    <input
                      class="sidebar-rename-input"
                      value={cat.name}
                      onBlur={(e) => handleRenameBlur(cat.id, e.currentTarget.value, "category")}
                      onKeyDown={handleRenameKeyDown}
                      ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
                    />
                  </div>
                </Show>
                <Show when={isExpanded()}>
                  <div class="sidebar-category-lists">
                    <For each={listsForCategory(cat.id)}>
                      {(list) => (
                        <Show
                          when={renamingId() === list.id}
                          fallback={
                            <div
                              class="sidebar-item"
                              classList={{ active: location.pathname === `/list/${list.id}`, selected: selectedListIds().has(list.id) }}
                              onClick={(e) => handleListClick(e, list)}
                              onContextMenu={(e) => handleContextMenu(e, { kind: "list", list })}
                            >
                              {list.name}
                              <span class="sidebar-item-count">{itemCountForList(list.id)}</span>
                            </div>
                          }
                        >
                          <div class="sidebar-item">
                            <input
                              class="sidebar-rename-input"
                              value={list.name}
                              onBlur={(e) => handleRenameBlur(list.id, e.currentTarget.value, "list")}
                              onKeyDown={handleRenameKeyDown}
                              ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
                            />
                          </div>
                        </Show>
                      )}
                    </For>
                    <div
                      class="sidebar-item sidebar-new"
                      onClick={() => handleNewList(cat.id)}
                    >
                      + New List
                    </div>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <div
          class="sidebar-item sidebar-new category"
          onClick={() => setShowCreateCategory(true)}
        >
          + New Category
        </div>
        <div
          class="sidebar-item sidebar-new"
          onClick={() => setImportScope({ type: "global" })}
        >
          ↓ Import
        </div>
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-sync-btn" onClick={() => setShowSync(true)}>
          <span
            class="sync-dot"
            style={`background: ${syncStatus() === "connected" ? "var(--success)" : syncStatus() === "connecting" ? "#f0a500" : syncStatus() === "error" ? "var(--danger)" : "var(--text-dim)"}`}
          />
          Sync
        </div>
      </div>

      <Show when={multiListCtxMenu()}>
        {(pos) => (
          <ContextMenu
            x={pos().x}
            y={pos().y}
            items={[{ label: `Delete ${selectedListIds().size} lists`, danger: true, action: deleteSelectedLists }]}
            onClose={() => setMultiListCtxMenu(null)}
          />
        )}
      </Show>

      <Show when={contextMenu()}>
        {(ctx) => (
          <ContextMenu
            x={ctx().x}
            y={ctx().y}
            items={menuItems()}
            onClose={() => setContextMenu(null)}
          />
        )}
      </Show>

      <CategoryFormModal
        open={editingCategory() !== undefined}
        onClose={() => setEditingCategory(undefined)}
        onSave={async (data) => {
          const cat = editingCategory();
          if (cat) await updateCategory(cat.id, { ...data, macros: data.macros });
          setEditingCategory(undefined);
        }}
        initial={editingCategory()}
      />

      <CategoryFormModal
        open={showCreateCategory()}
        onClose={() => setShowCreateCategory(false)}
        onSave={async (data) => {
          await createCategory(data.name, data.color, data.schema, data.format_string, data.macros);
          setShowCreateCategory(false);
        }}
      />

      <SyncSettingsModal open={showSync()} onClose={() => setShowSync(false)} />

      <Show when={importScope()}>
        {(scope) => (
          <ImportModal open={true} onClose={() => setImportScope(null)} scope={scope()} />
        )}
      </Show>
    </nav>
  );
};

export default Sidebar;
