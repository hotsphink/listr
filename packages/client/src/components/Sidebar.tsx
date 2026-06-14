import { type Component, For, Show, createSignal } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { List } from "@listr/shared";
import { db } from "../db/database.js";
import { updateList, deleteList } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";

const Sidebar: Component = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));

  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; list: List } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);

  const handleContextMenu = (e: MouseEvent, list: List) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, list });
  };

  const menuItems = (): MenuItem[] => {
    const ctx = contextMenu();
    if (!ctx) return [];
    return [
      {
        label: "Rename",
        action: () => setRenamingId(ctx.list.id),
      },
      {
        label: "Configure",
        action: () => navigate(`/list/${ctx.list.id}`, { state: { openSettings: true } }),
      },
      {
        label: "Delete",
        danger: true,
        action: async () => {
          if (!confirm(`Delete "${ctx.list.name}" and all its items?`)) return;
          await deleteList(ctx.list.id);
          if (location.pathname === `/list/${ctx.list.id}`) {
            navigate("/");
          }
        },
      },
    ];
  };

  const handleRenameBlur = async (id: string, newName: string) => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (trimmed) {
      await updateList(id, { name: trimmed });
    }
  };

  const handleRenameKeyDown = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

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
        <For each={lists() ?? []}>
          {(list) => (
            <Show
              when={renamingId() === list.id}
              fallback={
                <div
                  class="sidebar-item"
                  classList={{ active: location.pathname === `/list/${list.id}` }}
                  onClick={() => navigate(`/list/${list.id}`)}
                  onContextMenu={(e) => handleContextMenu(e, list)}
                >
                  {list.name}
                </div>
              }
            >
              <div class="sidebar-item">
                <input
                  class="sidebar-rename-input"
                  value={list.name}
                  onBlur={(e) => handleRenameBlur(list.id, e.currentTarget.value)}
                  onKeyDown={(e) => handleRenameKeyDown(e, list.id)}
                  ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
                />
              </div>
            </Show>
          )}
        </For>
      </div>
      <div class="sidebar-footer">
        <div
          class="sidebar-item"
          onClick={() => navigate("/")}
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
