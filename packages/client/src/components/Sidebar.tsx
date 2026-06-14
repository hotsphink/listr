import { type Component, For, Show, createSignal, createMemo } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Category, List } from "@listr/shared";
import { db } from "../db/database.js";
import { updateList, deleteList, updateCategory, deleteCategory } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";

const Sidebar: Component = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const categories = from(liveQuery(() => db.categories.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));

  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; target: { kind: "list"; list: List } | { kind: "category"; category: Category } } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);

  const uncategorizedLists = createMemo(() =>
    (lists() ?? []).filter((l) => !l.category_id),
  );

  const listsForCategory = (catId: string) =>
    (lists() ?? []).filter((l) => l.category_id === catId);

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
        { label: "Configure", action: () => navigate("/", { state: { editCategory: cat.id } }) },
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

  const renderListItem = (list: List) => (
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
  );

  return (
    <nav class="sidebar">
      <div
        class="sidebar-header"
        style="cursor: pointer"
        onClick={() => navigate("/")}
      >
        Listr
      </div>
      <div class="sidebar-content">
        <For each={categories() ?? []}>
          {(cat) => (
            <div class="sidebar-category">
              <Show
                when={renamingId() === cat.id}
                fallback={
                  <div
                    class="sidebar-category-header"
                    style={`border-left: 3px solid ${cat.color}`}
                    onContextMenu={(e) => handleContextMenu(e, { kind: "category", category: cat })}
                  >
                    {cat.name}
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
              <div class="sidebar-category-lists">
                <For each={listsForCategory(cat.id)}>
                  {(list) => renderListItem(list)}
                </For>
              </div>
            </div>
          )}
        </For>

        <Show when={uncategorizedLists().length > 0}>
          <For each={uncategorizedLists()}>
            {(list) => renderListItem(list)}
          </For>
        </Show>
      </div>
      <div class="sidebar-footer">
        <div
          class="sidebar-item"
          onClick={() => navigate("/", { state: { openCreate: true } })}
        >
          + New List
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
    </nav>
  );
};

export default Sidebar;
