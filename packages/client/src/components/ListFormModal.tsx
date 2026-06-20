import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import type { Board, List } from "@listr/shared";
import Modal from "./Modal.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; board_id: string; format_string: string | null }) => void;
  boards: Board[];
  initial?: List;
  defaultBoardId?: string | null;
}

const ListFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [boardId, setBoardId] = createSignal("");
  const [formatOverride, setFormatOverride] = createSignal("");
  const [overrideFormat, setOverrideFormat] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setBoardId(props.initial?.board_id ?? props.defaultBoardId ?? props.boards[0]?.id ?? "");
      const hasOverride = props.initial?.format_string != null;
      setOverrideFormat(hasOverride);
      setFormatOverride(props.initial?.format_string ?? "");
    }
  });

  const selectedBoard = () => props.boards.find((b) => b.id === boardId());

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim() || !boardId()) return;
    props.onSave({
      name: name().trim(),
      board_id: boardId(),
      format_string: overrideFormat() ? formatOverride() : null,
    });
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit List" : "New List"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field">
          <label>Name</label>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            autofocus
          />
        </div>
        <div class="form-field">
          <label>Board</label>
          <select
            value={boardId()}
            onChange={(e) => setBoardId(e.currentTarget.value)}
          >
            <For each={props.boards}>
              {(board) => <option value={board.id}>{board.name}</option>}
            </For>
          </select>
        </div>
        <Show when={selectedBoard()}>
          {(board) => (
            <div class="form-field">
              <div class="checkbox-field">
                <input
                  type="checkbox"
                  checked={overrideFormat()}
                  onChange={(e) => {
                    setOverrideFormat(e.currentTarget.checked);
                    if (e.currentTarget.checked && !formatOverride()) {
                      setFormatOverride(board().format_string);
                    }
                  }}
                />
                <label style="margin-bottom: 0; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text)">
                  Override board format string
                </label>
              </div>
              <Show when={overrideFormat()}>
                <input
                  value={formatOverride()}
                  onInput={(e) => setFormatOverride(e.currentTarget.value)}
                  placeholder={board().format_string}
                />
              </Show>
              <Show when={!overrideFormat()}>
                <div style="font-size: 12px; color: var(--text-muted)">
                  Using: {board().format_string}
                </div>
              </Show>
            </div>
          )}
        </Show>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn-primary">
            {props.initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ListFormModal;
