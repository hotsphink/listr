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
  // "My Boards"'s key used to be the hand-typed sync_config.sync_key; now
  // it's the server-assigned home key of whichever server this device is
  // actively registered with (§3.1/§8.1) — sync_config.sync_key is retired.
  // Arbitrarily the first active registration if there's more than one
  // (§3.3.1's stated non-goal multi-server case), same "pick one" convention
  // SyncClient.getPrimaryServerId uses.
  const serverIdentities = from(liveQuery(() => db.server_identity.toArray()));
  const defaultSyncKey = () => serverIdentities()?.find((i) => i.state === "active" && i.home_key)?.home_key ?? undefined;
  const groupMeta = from(liveQuery(() => db.board_groups.toArray()));

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

  // Partition boards into "My Boards" (default key), named board groups (a
  // non-default key explicitly marked as a group — e.g. created via "New Board
  // Group" or accepted from a group share link), and a catch-all "Shared Boards"
  // bucket for everything else — including boards that merely happen to share a
  // sync_key without ever having been deliberately grouped.
  const boardGroups = createMemo(() => {
    const key = defaultSyncKey();
    const own: Board[] = [];
    const byOtherKey = new Map<string, Board[]>();
    for (const b of boards() ?? []) {
      if (!b.sync_key || b.sync_key === key) { own.push(b); continue; }
      const list = byOtherKey.get(b.sync_key);
      if (list) list.push(b); else byOtherKey.set(b.sync_key, [b]);
    }

    const metaByKey = new Map((groupMeta() ?? []).map((m) => [m.key, m.name]));
    const namedGroups: { key: string; name: string; boards: Board[] }[] = [];
    const singles: Board[] = [];
    for (const [k, bds] of byOtherKey) {
      const explicitName = metaByKey.get(k);
      if (explicitName) {
        namedGroups.push({ key: k, name: explicitName, boards: bds });
      } else {
        singles.push(...bds);
      }
    }
    return { own, namedGroups, singles };
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

  const renderGroupHeader = (groupKey: string, name: string, shareKey?: string) => (
    <div class="sidebar-group-header" onClick={() => toggleGroupCollapsed(groupKey)}>
      <span class="sidebar-group-chevron">{collapsedGroups().has(groupKey) ? "▸" : "▾"}</span>
      <span class="sidebar-group-title">{name}</span>
      <Show when={shareKey}>
        <button
          class="sidebar-group-share-btn"
          type="button"
          title={`Share ${name}`}
          aria-label={`Share ${name}`}
          onClick={(e) => { e.stopPropagation(); setSharingGroup({ key: shareKey!, name }); }}
        >
          <ShareIcon />
        </button>
      </Show>
    </div>
  );

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
          {renderGroupHeader("own", "My Boards", defaultSyncKey())}
          <div class="sidebar-group-boards-wrapper" classList={{ expanded: !collapsedGroups().has("own") }}>
            <div class="sidebar-group-boards">
              <For each={boardGroups().own}>{renderBoardRow}</For>
            </div>
          </div>
        </div>

        <For each={boardGroups().namedGroups}>
          {(group) => (
            <div class="sidebar-group">
              {renderGroupHeader(group.key, group.name, group.key)}
              <div class="sidebar-group-boards-wrapper" classList={{ expanded: !collapsedGroups().has(group.key) }}>
                <div class="sidebar-group-boards">
                  <For each={group.boards}>{renderBoardRow}</For>
                </div>
              </div>
            </div>
          )}
        </For>

        <Show when={boardGroups().singles.length > 0}>
          <div class="sidebar-group">
            {renderGroupHeader("shared", "Shared Boards")}
            <div class="sidebar-group-boards-wrapper" classList={{ expanded: !collapsedGroups().has("shared") }}>
              <div class="sidebar-group-boards">
                <For each={boardGroups().singles}>{renderBoardRow}</For>
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
          await createBoard(data.name, data.color, {
            schema: data.schema,
            formatString: data.format_string,
            macros: data.macros,
            syncKey: data.sync_key || undefined,
          });
          setShowCreateBoard(false);
        }}
      />

      <BoardFormModal
        open={creatingGroupKey() !== null}
        onClose={() => setCreatingGroupKey(null)}
        defaultSyncKey={creatingGroupKey() ?? undefined}
        onSave={async (data) => {
          const key = creatingGroupKey();
          const finalKey = data.sync_key || key || undefined;
          await createBoard(data.name, data.color, {
            schema: data.schema,
            formatString: data.format_string,
            macros: data.macros,
            syncKey: finalKey,
            groupName: finalKey ? data.name : undefined,
          });
          setCreatingGroupKey(null);
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
