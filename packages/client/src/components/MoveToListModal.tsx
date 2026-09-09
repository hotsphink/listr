import { type Component, For, Show, createMemo, createSignal, createEffect } from "solid-js";
import { liveQuery } from "dexie";
import { from } from "solid-js";
import { db } from "../db/database.js";
import { createList } from "../db/operations.js";
import Modal from "./Modal.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSelect: (listId: string) => void;
  currentBoardId?: string;
}

const MoveToListModal: Component<Props> = (props) => {
  const boards = from(liveQuery(() => db.boards.orderBy("position").toArray()));
  const lists  = from(liveQuery(() => db.lists.orderBy("position").toArray()));

  const [expandedIds, setExpandedIds] = createSignal<Set<string>>(
    new Set(props.currentBoardId ? [props.currentBoardId] : []),
  );

  // Reset to current board expanded each time the modal opens.
  createEffect(() => {
    if (props.open) {
      setExpandedIds(new Set(props.currentBoardId ? [props.currentBoardId] : []));
    }
  });

  const toggle = (boardId: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.has(boardId) ? next.delete(boardId) : next.add(boardId);
      return next;
    });

  const groups = createMemo(() =>
    (boards() ?? []).map((board) => ({
      board,
      lists: (lists() ?? []).filter((l) => l.board_id === board.id),
    })),
  );

  const handleNewList = async (boardId: string) => {
    const list = await createList("New List", boardId);
    props.onSelect(list.id);
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <div class="header-row">
        <h2>Move to list</h2>
        <button type="button" class="btn-icon" onClick={props.onClose} aria-label="Cancel">✕</button>
      </div>
      <div class="move-to-list-groups">
        <For each={groups()}>
          {({ board, lists }) => {
            const expanded = () => expandedIds().has(board.id);
            return (
              <div class="move-to-list-group">
                <button
                  type="button"
                  class="btn-bare move-to-list-board board-stripe"
                  style={`--board-color: ${board.color}`}
                  aria-expanded={expanded()}
                  onClick={() => toggle(board.id)}
                >
                  <span class="move-to-list-chevron" aria-hidden="true">{expanded() ? "▾" : "▸"}</span>
                  {board.name}
                </button>
                <Show when={expanded()}>
                  <For each={lists}>
                    {(list) => (
                      <button
                        type="button"
                        class="move-to-list-item"
                        onClick={() => props.onSelect(list.id)}
                      >
                        {list.name}
                      </button>
                    )}
                  </For>
                  <button
                    type="button"
                    class="move-to-list-item move-to-list-new"
                    onClick={() => handleNewList(board.id)}
                  >
                    + New list
                  </button>
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </Modal>
  );
};

export default MoveToListModal;
