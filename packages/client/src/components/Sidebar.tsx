import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Board, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createList, createBoard, updateList, deleteList, updateBoard, deleteBoard } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";
import BoardFormModal from "./BoardFormModal.js";
import ImportModal, { type ImportScope } from "./ImportModal.js";
import { syncStatus } from "../sync/syncStore.js";
import { selectedListIds, setSelectedListIds } from "../store/sidebarSelection.js";
import { exportAllData, exportBoard, exportList } from "../db/exportImport.js";
import type { NativeExport } from "../db/exportImport.js";

function triggerDownload(data: NativeExport, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface Props {
  open?: boolean;
  onClose?: () => void;
}

const Sidebar: Component<Props> = (props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const boards = from(liveQuery(() => db.boards.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));
  const itemCounts = from(liveQuery(async () => {
    const allLists = await db.lists.toArray();
    const entries = await Promise.all(
      allLists.map(async (l) => [l.id, await db.items.where("list_id").equals(l.id).count()] as const)
    );
    return new Map<string, number>(entries);
  }));

  const itemCountForList = (listId: string) => itemCounts()?.get(listId) ?? 0;

  const [expandedBoardId, setExpandedBoardId] = createSignal<string | null>(null);
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; target: { kind: "list"; list: List } | { kind: "board"; board: Board } } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [editingBoard, setEditingBoard] = createSignal<Board | undefined>();
  const [showCreateBoard, setShowCreateBoard] = createSignal(false);
  const [importScope, setImportScope] = createSignal<ImportScope | null>(null);
  const [anchorListId, setAnchorListId] = createSignal<string | null>(null);
  const [multiListCtxMenu, setMultiListCtxMenu] = createSignal<{ x: number; y: number } | null>(null);

  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  const listsForBoard = (boardId: string) =>
    (lists() ?? []).filter((l) => l.board_id === boardId);

  const toggleBoard = (boardId: string) => {
    setExpandedBoardId((prev) => (prev === boardId ? null : boardId));
  };

  const handleContextMenu = (e: MouseEvent, target: { kind: "list"; list: List } | { kind: "board"; board: Board }) => {
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
      const board = (boards() ?? []).find((b) => b.id === list.board_id);
      return [
        { label: "Rename", action: () => setRenamingId(list.id) },
        { label: "Configure", action: () => { setSelectedListIds(new Set([list.id])); props.onClose?.(); navigate(`/board/${list.board_id}`, { state: { openSettings: list.id } }); } },
        { label: "Import", action: () => board && setImportScope({
            type: "list",
            id: list.id,
            name: list.name,
            schema: board.schema,
            format_string: list.format_string ?? board.format_string,
            macros: board.macros ?? {},
          })
        },
        { label: "Export", action: async () => {
            const data = await exportList(list.id);
            const date = new Date().toISOString().slice(0, 10);
            triggerDownload(data, `listr-list-${list.name}-${date}.json`);
          }
        },
        { label: "Delete", danger: true, action: async () => {
          if (!confirm(`Delete "${list.name}" and all its items?`)) return;
          await deleteList(list.id);
          setSelectedListIds((prev) => { const n = new Set(prev); n.delete(list.id); return n; });
        }},
      ];
    } else {
      const board = ctx.target.board;
      return [
        { label: "Rename", action: () => setRenamingId(board.id) },
        { label: "Configure", action: () => setEditingBoard(board) },
        { label: "Import", action: () => setImportScope({
            type: "board",
            id: board.id,
            name: board.name,
            schema: board.schema,
            format_string: board.format_string,
            macros: board.macros ?? {},
          })
        },
        { label: "Export", action: async () => {
            const data = await exportBoard(board.id);
            const date = new Date().toISOString().slice(0, 10);
            triggerDownload(data, `listr-board-${board.name}-${date}.json`);
          }
        },
        { label: "Delete", danger: true, action: async () => {
          const listCount = listsForBoard(board.id).length;
          const msg = listCount > 0
            ? `Delete "${board.name}" and its ${listCount} list${listCount > 1 ? "s" : ""} with all items?`
            : `Delete board "${board.name}"?`;
          if (!confirm(msg)) return;
          await deleteBoard(board.id);
          props.onClose?.();
          navigate("/");
        }},
      ];
    }
  };

  const handleRenameBlur = async (id: string, newName: string, kind: "list" | "board") => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    if (kind === "list") {
      await updateList(id, { name: trimmed });
    } else {
      await updateBoard(id, { name: trimmed });
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
    e.stopPropagation();
    if (e.shiftKey && anchorListId()) {
      const boardLists = listsForBoard(list.board_id);
      const ids = boardLists.map((l) => l.id);
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
    if (selectedListIds().size === 1 && selectedListIds().has(list.id)) {
      setSelectedListIds(new Set<string>());
    } else {
      setSelectedListIds(new Set([list.id]));
    }
    props.onClose?.();
    navigate(`/board/${list.board_id}`);
  };

  const deleteSelectedLists = async () => {
    const ids = [...selectedListIds()];
    if (!confirm(`Delete ${ids.length} list${ids.length !== 1 ? "s" : ""} and all their items?`)) return;
    for (const id of ids) {
      await deleteList(id);
    }
    setSelectedListIds(new Set<string>());
    setMultiListCtxMenu(null);
  };

  const handleNewList = async (boardId: string) => {
    const list = await createList("New List", boardId);
    setRenamingId(list.id);
    setSelectedListIds(new Set([list.id]));
    props.onClose?.();
    navigate(`/board/${boardId}`);
  };

  return (
    <nav class="sidebar" classList={{ open: props.open ?? false }}>
      <div
        class="sidebar-header"
        style="cursor: pointer"
        onClick={() => { props.onClose?.(); navigate("/"); }}
      >
        Listr
      </div>
      <div class="sidebar-content">
        <For each={boards() ?? []}>
          {(board) => {
            const isExpanded = () => expandedBoardId() === board.id;
            return (
              <div class="sidebar-board">
                <Show
                  when={renamingId() === board.id}
                  fallback={
                    <div
                      class="sidebar-board-header"
                      classList={{ expanded: isExpanded() }}
                      style={`border-left: 3px solid ${board.color}`}
                      onClick={() => { toggleBoard(board.id); if (!isTouch) { setSelectedListIds(new Set<string>()); props.onClose?.(); navigate(`/board/${board.id}`); } }}
                      onContextMenu={(e) => handleContextMenu(e, { kind: "board", board })}
                    >
                      <span class="sidebar-board-chevron">{isExpanded() ? "▾" : "▸"}</span>
                      {board.name}
                      <span class="sidebar-board-count">{listsForBoard(board.id).length}</span>
                    </div>
                  }
                >
                  <div class="sidebar-board-header" style={`border-left: 3px solid ${board.color}`}>
                    <input
                      class="sidebar-rename-input"
                      value={board.name}
                      onBlur={(e) => handleRenameBlur(board.id, e.currentTarget.value, "board")}
                      onKeyDown={handleRenameKeyDown}
                      ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
                    />
                  </div>
                </Show>
                <Show when={isExpanded()}>
                  <div class="sidebar-board-lists">
                    <For each={listsForBoard(board.id)}>
                      {(list) => (
                        <Show
                          when={renamingId() === list.id}
                          fallback={
                            <div
                              class="sidebar-item"
                              classList={{ active: selectedListIds().has(list.id) && location.pathname === `/board/${list.board_id}`, selected: selectedListIds().has(list.id) }}
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
                      onClick={() => handleNewList(board.id)}
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
          class="sidebar-item sidebar-new board"
          onClick={() => setShowCreateBoard(true)}
        >
          + New Board
        </div>
        <div
          class="sidebar-item sidebar-new"
          onClick={async () => {
            const data = await exportAllData();
            const date = new Date().toISOString().slice(0, 10);
            triggerDownload(data, `listr-${date}.json`);
          }}
        >
          ↑ Export
        </div>
        <div
          class="sidebar-item sidebar-new"
          onClick={() => setImportScope({ type: "global" })}
        >
          ↓ Import
        </div>
      </div>
      <div class="sidebar-footer">
        <div class="sidebar-sync-btn" onClick={() => { props.onClose?.(); navigate("/admin"); }}>
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

      <BoardFormModal
        open={editingBoard() !== undefined}
        onClose={() => setEditingBoard(undefined)}
        onSave={async (data) => {
          const board = editingBoard();
          if (board) await updateBoard(board.id, { ...data, macros: data.macros });
          setEditingBoard(undefined);
        }}
        initial={editingBoard()}
      />

      <BoardFormModal
        open={showCreateBoard()}
        onClose={() => setShowCreateBoard(false)}
        onSave={async (data) => {
          await createBoard(data.name, data.color, data.schema, data.format_string, data.macros);
          setShowCreateBoard(false);
        }}
      />

      <Show when={importScope()}>
        {(scope) => (
          <ImportModal open={true} onClose={() => setImportScope(null)} scope={scope()} />
        )}
      </Show>
    </nav>
  );
};

export default Sidebar;
