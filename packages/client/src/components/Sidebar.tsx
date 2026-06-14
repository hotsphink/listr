import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Category, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createList, createCategory, updateList, deleteList, updateCategory, deleteCategory } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";
import CategoryFormModal from "./CategoryFormModal.js";

interface Props {
  open?: boolean;
  onClose?: () => void;
}

const Sidebar: Component<Props> = (props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const categories = from(liveQuery(() => db.categories.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));

  const [expandedCategoryId, setExpandedCategoryId] = createSignal<string | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; target: { kind: "list"; list: List } | { kind: "category"; category: Category } } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [editingCategory, setEditingCategory] = createSignal<Category | undefined>();
  const [showCreateCategory, setShowCreateCategory] = createSignal(false);

  // Auto-expand the category containing the active list; auto-close sidebar on mobile
  createEffect(() => {
    const path = location.pathname;
    const match = path.match(/^\/list\/(.+)/);
    if (match) {
      const listId = match[1];
      const list = (lists() ?? []).find((l) => l.id === listId);
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
    setContextMenu({ x: e.clientX, y: e.clientY, target });
  };

  const menuItems = (): MenuItem[] => {
    const ctx = contextMenu();
    if (!ctx) return [];

    if (ctx.target.kind === "list") {
      const list = ctx.target.list;
      return [
        { label: "Rename", action: () => setRenamingId(list.id) },
        { label: "Configure", action: () => navigate(`/list/${list.id}`, { state: { openSettings: true } }) },
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
                      onClick={() => toggleCategory(cat.id)}
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
                              classList={{ active: location.pathname === `/list/${list.id}` }}
                              onClick={() => navigate(`/list/${list.id}`)}
                              onContextMenu={(e) => handleContextMenu(e, { kind: "list", list })}
                            >
                              {list.name}
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
                      class="sidebar-item sidebar-new-list"
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
          class="sidebar-item sidebar-new-category"
          onClick={() => setShowCreateCategory(true)}
        >
          + New Category
        </div>
      </div>

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
    </nav>
  );
};

export default Sidebar;
