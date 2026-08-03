import { type Component, For, Show, createSignal, createEffect } from "solid-js";
import { useNavigate, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import type { Board, Integration, List } from "@listr/shared";
import { db } from "../db/database.js";
import { createList, createBoard, updateBoard } from "../db/operations.js";
import ListFormModal from "../components/ListFormModal.js";
import BoardFormModal from "../components/BoardFormModal.js";

const Dashboard: Component = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [showCreateList, setShowCreateList] = createSignal(false);
  const [showCreateBoard, setShowCreateBoard] = createSignal(false);
  const [editingBoard, setEditingBoard] = createSignal<Board | undefined>();

  const boards = from(liveQuery(() => db.boards.orderBy("position").toArray()));
  const lists = from(liveQuery(() => db.lists.orderBy("position").toArray()));
  const itemCounts = from(
    liveQuery(async () => {
      const allItems = await db.items.toArray();
      const counts: Record<string, number> = {};
      for (const item of allItems) {
        counts[item.list_id] = (counts[item.list_id] ?? 0) + 1;
      }
      return counts;
    }),
  );

  createEffect(() => {
    const state = location.state as any;
    if (state?.openCreate) {
      setShowCreateList(true);
      navigate("/", { replace: true });
    }
    if (state?.openCreateBoard) {
      setShowCreateBoard(true);
      navigate("/", { replace: true });
    }
    if (state?.editBoard) {
      const board = (boards() ?? []).find((b) => b.id === state.editBoard);
      if (board) setEditingBoard(board);
      navigate("/", { replace: true });
    }
  });

  const listsForBoard = (boardId: string) =>
    (lists() ?? []).filter((l) => l.board_id === boardId);

  const handleCreateList = async (data: { name: string; board_id: string; format_string: string | null; integrations: Integration[] | null }) => {
    const list = await createList(data.name, data.board_id);
    const listUpdates: Record<string, unknown> = {};
    if (data.format_string != null) listUpdates.format_string = data.format_string;
    if (data.integrations != null) listUpdates.integrations = data.integrations;
    if (Object.keys(listUpdates).length) await db.lists.update(list.id, listUpdates);
    setShowCreateList(false);
    navigate(`/list/${list.id}`);
  };

  const handleCreateBoard = async (data: { name: string; color: string; format_string: string; schema: any[]; macros: Record<string, string>; sync_key: string; integrations: Integration[] }) => {
    await createBoard(data.name, data.color, data.schema, data.format_string, data.macros, data.sync_key || undefined, data.integrations.length ? data.integrations : undefined);
    setShowCreateBoard(false);
  };

  const handleEditBoard = async (data: { name: string; color: string; format_string: string; schema: any[]; macros: Record<string, string>; sync_key: string; integrations: Integration[] }) => {
    const board = editingBoard();
    if (!board) return;
    await updateBoard(board.id, { ...data, integrations: data.integrations.length ? data.integrations : undefined });
    setEditingBoard(undefined);
  };

  const renderListCard = (list: List) => (
    <a class="card list" href={`/list/${list.id}`} onClick={(e) => { e.preventDefault(); navigate(`/list/${list.id}`); }}>
      <div class="card-name">{list.name}</div>
      <div class="card-count">
        {itemCounts()?.[list.id] ?? 0} items
      </div>
    </a>
  );

  return (
    <div class="main">
      <div class="page-header">
        <h1>Lists</h1>
        <div class="header-actions">
          <button class="btn-ghost" onClick={() => setShowCreateBoard(true)}>
            + Board
          </button>
          <button class="btn-primary" onClick={() => setShowCreateList(true)}>
            + New List
          </button>
        </div>
      </div>

      <div class="dashboard">
        <Show
          when={(boards() ?? []).length > 0 || (lists() ?? []).length > 0}
          fallback={
            <div class="empty-state">
              <p>No lists yet. Create a board and list to get started.</p>
              <button class="btn-primary" onClick={() => setShowCreateBoard(true)}>
                + New Board
              </button>
            </div>
          }
        >
          <For each={boards() ?? []}>
            {(board) => (
              <div class="dashboard-board">
                <div class="dashboard-board-header">
                  <h2 style={`border-left: 3px solid ${board.color}; padding-left: 8px`}>{board.name}</h2>
                  <button class="btn-icon" onClick={() => setEditingBoard(board)} title="Edit board">
                    ⚙
                  </button>
                </div>
                <Show
                  when={listsForBoard(board.id).length > 0}
                  fallback={
                    <div style="color: var(--text-dim); font-size: 13px; padding: 4px 0 12px">
                      No lists yet
                    </div>
                  }
                >
                  <div class="list-grid">
                    <For each={listsForBoard(board.id)}>
                      {(list) => renderListCard(list)}
                    </For>
                  </div>
                </Show>
              </div>
            )}
          </For>

        </Show>
      </div>

      <ListFormModal
        open={showCreateList()}
        onClose={() => setShowCreateList(false)}
        onSave={handleCreateList}
        boards={boards() ?? []}
      />

      <BoardFormModal
        open={showCreateBoard()}
        onClose={() => setShowCreateBoard(false)}
        onSave={handleCreateBoard}
      />

      <BoardFormModal
        open={editingBoard() !== undefined}
        onClose={() => setEditingBoard(undefined)}
        onSave={handleEditBoard}
        initial={editingBoard()}
      />
    </div>
  );
};

export default Dashboard;
