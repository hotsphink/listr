import { type Component, For, Show, createSignal, createEffect, createMemo } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Board } from "@listr/shared";
import { db } from "../db/database.js";
import { createBoard, updateBoard, deleteBoard, removeByKey } from "../db/operations.js";
import ContextMenu, { type MenuItem } from "./ContextMenu.js";
import BoardFormModal from "./BoardFormModal.js";
import ImportModal, { type ImportScope } from "./ImportModal.js";
import BoardShareModal from "./BoardShareModal.js";
import ScanShareModal from "./ScanShareModal.js";
import ShareIcon from "./ShareIcon.js";
import { syncStatus } from "../sync/syncStore.js";
import { generateShareKey } from "../sync/shareToken.js";
import { collapsedGroups, toggleGroupCollapsed } from "../store/sidebarGroups.js";
import { exportAllData, exportBoard, exportList } from "../db/exportImport.js";
import { triggerDownload } from "../utils/download.js";

interface Props {
  open?: boolean;
  onClose?: () => void;
}

const Sidebar: Component<Props> = (props) => {
  const navigate = useNavigate();
  const location = useLocation();

  const boards = from(liveQuery(() => db.boards.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));
  const syncConfig = from(liveQuery(() => db.sync_config.get("default")));
  const defaultSyncKey = () => syncConfig()?.sync_key;

  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; board: Board } | null>(null);
  const [renamingId, setRenamingId] = createSignal<string | null>(null);
  const [editingBoard, setEditingBoard] = createSignal<Board | undefined>();
  const [showCreateBoard, setShowCreateBoard] = createSignal(false);
  const [importScope, setImportScope] = createSignal<ImportScope | null>(null);
  const [sharingBoard, setSharingBoard] = createSignal<Board | undefined>();
  const [sharingGroup, setSharingGroup] = createSignal<{ key: string; name: string } | undefined>();
  const [creatingGroupKey, setCreatingGroupKey] = createSignal<string | null>(null);
  const [showScanShare, setShowScanShare] = createSignal(false);

  // Reset all transient UI state when the panel closes so stale modals/renames
  // don't reappear on the next open.
  createEffect(() => {
    if (!props.open) {
      setEditingBoard(undefined);
      setShowCreateBoard(false);
      setRenamingId(null);
      setContextMenu(null);
      setImportScope(null);
      setCreatingGroupKey(null);
    }
  });

  const listsForBoard = (boardId: string) =>
    (lists() ?? []).filter((l) => l.board_id === boardId);

  const boardGroups = createMemo(() => {
    const key = defaultSyncKey();
    const own: Board[] = [];
    const shared: Board[] = [];
    for (const b of boards() ?? []) {
      (!b.sync_key || b.sync_key === key ? own : shared).push(b);
    }
    return { own, shared };
  });

  const menuItems = (): MenuItem[] => {
    const ctx = contextMenu();
    if (!ctx) return [];

    const board = ctx.board;
    const canRemove = !!board.sync_key;
    return [
      { label: "Rename", action: () => setRenamingId(board.id) },
      { label: "Edit", action: () => setEditingBoard(board) },
      { label: "Share", action: () => setSharingBoard(board) },
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
      ...(canRemove ? [{
        label: "Remove",
        action: async () => {
          const sk = board.sync_key!;
          const others = (boards() ?? []).filter((b) => b.sync_key === sk && b.id !== board.id);
          let msg = `Remove "${board.name}" from this device only?`;
          if (others.length > 0) {
            const names = others.map((b) => `"${b.name}"`).join(", ");
            msg += ` This will also remove ${names}, which share${others.length === 1 ? "s" : ""} the same sync key.`;
          }
          msg += " Other devices keeping this sync key are unaffected.";
          if (!confirm(msg)) return;
          await removeByKey(sk);
          props.onClose?.();
          navigate("/");
        },
      }] : []),
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
  };

  const handleRenameBlur = async (id: string, newName: string) => {
    setRenamingId(null);
    const trimmed = newName.trim();
    if (!trimmed) return;
    await updateBoard(id, { name: trimmed });
  };

  const handleRenameKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      (e.currentTarget as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setRenamingId(null);
    }
  };

  const renderBoardRow = (board: Board) => (
    <Show
      when={renamingId() === board.id}
      fallback={
        <div
          class="sidebar-item sidebar-board"
          classList={{ active: location.pathname === `/board/${board.id}` }}
          style={`border-left: 3px solid ${board.color}`}
          onClick={() => { navigate(`/board/${board.id}`); props.onClose?.(); }}
          onDblClick={() => setEditingBoard(board)}
          onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, board }); }}
        >
          <span class="sidebar-board-name">
            {board.name}
            <Show when={board.sync_key}>
              <ShareIcon class="sidebar-board-shared-icon" />
            </Show>
          </span>
        </div>
      }
    >
      <div class="sidebar-item sidebar-board">
        <input
          class="sidebar-rename-input"
          value={board.name}
          onBlur={(e) => handleRenameBlur(board.id, e.currentTarget.value)}
          onKeyDown={handleRenameKeyDown}
          ref={(el) => setTimeout(() => { el.focus(); el.select(); }, 0)}
        />
      </div>
    </Show>
  );

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
        <div class="sidebar-group">
          <div class="sidebar-group-header" onClick={() => toggleGroupCollapsed("own")}>
            <span class="sidebar-group-chevron">{collapsedGroups().has("own") ? "▸" : "▾"}</span>
            <span class="sidebar-group-title">My Boards</span>
            <Show when={defaultSyncKey()}>
              <button
                class="sidebar-group-share-btn"
                type="button"
                title="Share My Boards"
                aria-label="Share My Boards"
                onClick={(e) => { e.stopPropagation(); setSharingGroup({ key: defaultSyncKey()!, name: "My Boards" }); }}
              >
                <ShareIcon />
              </button>
            </Show>
          </div>
          <div class="sidebar-group-boards-wrapper" classList={{ expanded: !collapsedGroups().has("own") }}>
            <div class="sidebar-group-boards">
              <For each={boardGroups().own}>{renderBoardRow}</For>
            </div>
          </div>
        </div>

        <Show when={boardGroups().shared.length > 0}>
          <div class="sidebar-group">
            <div class="sidebar-group-header" onClick={() => toggleGroupCollapsed("shared")}>
              <span class="sidebar-group-chevron">{collapsedGroups().has("shared") ? "▸" : "▾"}</span>
              <span class="sidebar-group-title">Shared Boards</span>
            </div>
            <div class="sidebar-group-boards-wrapper" classList={{ expanded: !collapsedGroups().has("shared") }}>
              <div class="sidebar-group-boards">
                <For each={boardGroups().shared}>{renderBoardRow}</For>
              </div>
            </div>
          </div>
        </Show>

        <div
          class="sidebar-item sidebar-new board"
          onClick={() => setShowCreateBoard(true)}
        >
          + New Board
        </div>
        <div
          class="sidebar-item sidebar-new"
          onClick={() => setCreatingGroupKey(generateShareKey())}
        >
          + New Board Group
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
        <div
          class="sidebar-item sidebar-new"
          onClick={() => setShowScanShare(true)}
        >
          ⬚ Receive Share
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

      <BoardShareModal
        open={sharingBoard() !== undefined || sharingGroup() !== undefined}
        onClose={() => { setSharingBoard(undefined); setSharingGroup(undefined); }}
        board={sharingBoard()}
        group={sharingGroup()}
      />

      <ScanShareModal
        open={showScanShare()}
        onClose={() => setShowScanShare(false)}
      />

      <BoardFormModal
        open={editingBoard() !== undefined}
        onClose={() => setEditingBoard(undefined)}
        onSave={async (data) => {
          const board = editingBoard();
          if (board) await updateBoard(board.id, { ...data, macros: data.macros, sync_key: data.sync_key || undefined });
          setEditingBoard(undefined);
        }}
        initial={editingBoard()}
      />

      <BoardFormModal
        open={showCreateBoard()}
        onClose={() => setShowCreateBoard(false)}
        onSave={async (data) => {
          await createBoard(data.name, data.color, data.schema, data.format_string, data.macros, data.sync_key || undefined);
          setShowCreateBoard(false);
        }}
      />

      <BoardFormModal
        open={creatingGroupKey() !== null}
        onClose={() => setCreatingGroupKey(null)}
        defaultSyncKey={creatingGroupKey() ?? undefined}
        onSave={async (data) => {
          const key = creatingGroupKey();
          const board = await createBoard(data.name, data.color, data.schema, data.format_string, data.macros, data.sync_key || key || undefined);
          setCreatingGroupKey(null);
          setSharingBoard(board);
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
