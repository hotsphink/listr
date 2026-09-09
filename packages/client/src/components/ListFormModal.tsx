import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import type { Board, Integration, List } from "@listr/shared";
import Modal from "./Modal.js";
import IntegrationsEditor from "./IntegrationsEditor.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; board_id: string; format_string: string | null; integrations: Integration[] | null }) => void;
  boards: Board[];
  initial?: List;
  defaultBoardId?: string | null;
}

const ListFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [boardId, setBoardId] = createSignal("");
  const [formatOverride, setFormatOverride] = createSignal("");
  const [overrideFormat, setOverrideFormat] = createSignal(false);
  const [overrideIntegrations, setOverrideIntegrations] = createSignal(false);
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setBoardId(props.initial?.board_id ?? props.defaultBoardId ?? props.boards[0]?.id ?? "");
      const hasOverride = props.initial?.format_string != null;
      setOverrideFormat(hasOverride);
      setFormatOverride(props.initial?.format_string ?? "");
      const hasIntegrationOverride = props.initial?.integrations != null;
      setOverrideIntegrations(hasIntegrationOverride);
      setIntegrations(props.initial?.integrations ?? []);
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
      integrations: overrideIntegrations() ? integrations() : null,
    });
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit List" : "New List"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field">
          <label class="field-label">Name</label>
          <input
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            autofocus
          />
        </div>
        <div class="form-field">
          <label class="field-label">Board</label>
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
              <label class="check-label">
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
                Override board format string
              </label>
              <Show when={overrideFormat()}>
                <input
                  value={formatOverride()}
                  onInput={(e) => setFormatOverride(e.currentTarget.value)}
                  placeholder={board().format_string}
                />
              </Show>
              <Show when={!overrideFormat()}>
                <div class="field-hint">Using: {board().format_string}</div>
              </Show>
            </div>
          )}
        </Show>
        <div class="form-field">
          <label class="check-label">
            <input
              type="checkbox"
              checked={overrideIntegrations()}
              onChange={(e) => setOverrideIntegrations(e.currentTarget.checked)}
            />
            Override board integrations
          </label>
          <Show when={overrideIntegrations()}>
            <IntegrationsEditor integrations={integrations()} onChange={setIntegrations} />
          </Show>
          <Show when={!overrideIntegrations()}>
            <div class="field-hint">Using board integrations</div>
          </Show>
        </div>
        <div class="actions">
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
