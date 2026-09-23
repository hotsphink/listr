import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import { FORMAT_VERSION, type Board, type FormatSpec, type Integration, type Item, type List } from "@listr/shared";
import Modal from "./Modal.js";
import IntegrationsEditor from "./IntegrationsEditor.js";
import FormatEditor, { formatHasErrors } from "./FormatEditor.js";
import { db } from "../db/database.js";

export interface ListFormData {
  name: string;
  board_id: string;
  /** null = use the board's format. */
  format: FormatSpec | null;
  integrations: Integration[] | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: ListFormData) => void;
  boards: Board[];
  initial?: List;
  defaultBoardId?: string | null;
}

let seq = 0;

const ListFormModal: Component<Props> = (props) => {
  const uid = `list-form-${++seq}`;
  const [name, setName] = createSignal("");
  const [boardId, setBoardId] = createSignal("");
  const [formatOverride, setFormatOverride] = createSignal("");
  const [overrideFormat, setOverrideFormat] = createSignal(false);
  const [formatError, setFormatError] = createSignal<string | null>(null);
  const [sampleItem, setSampleItem] = createSignal<Item | undefined>();
  const [overrideIntegrations, setOverrideIntegrations] = createSignal(false);
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setBoardId(props.initial?.board_id ?? props.defaultBoardId ?? props.boards[0]?.id ?? "");
      setOverrideFormat(props.initial?.format != null);
      setFormatOverride(props.initial?.format?.text ?? "");
      setFormatError(null);
      setSampleItem(undefined);
      if (props.initial) {
        db.items.where("list_id").equals(props.initial.id).first().then(setSampleItem).catch(console.error);
      }
      const hasIntegrationOverride = props.initial?.integrations != null;
      setOverrideIntegrations(hasIntegrationOverride);
      setIntegrations(props.initial?.integrations ?? []);
    }
  });

  const selectedBoard = () => props.boards.find((b) => b.id === boardId());

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim() || !boardId()) return;
    if (overrideFormat() && formatHasErrors(formatOverride(), selectedBoard()?.schema ?? [])) {
      setFormatError("Fix the errors in the format before saving.");
      return;
    }
    props.onSave({
      name: name().trim(),
      board_id: boardId(),
      format: overrideFormat() ? { version: FORMAT_VERSION, text: formatOverride() } : null,
      integrations: overrideIntegrations() ? integrations() : null,
    });
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit List" : "New List"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field">
          <label class="field-label" for={`${uid}-name`}>Name</label>
          <input
            id={`${uid}-name`}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            autofocus
          />
        </div>
        <div class="form-field">
          <label class="field-label" for={`${uid}-board`}>Board</label>
          <select
            id={`${uid}-board`}
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
                      setFormatOverride(board().format.text);
                    }
                  }}
                />
                Override board format
              </label>
              <Show when={overrideFormat()}>
                <FormatEditor
                  id={`${uid}-format`}
                  value={formatOverride()}
                  onInput={(v) => { setFormatOverride(v); setFormatError(null); }}
                  schema={board().schema}
                  sampleItem={sampleItem()}
                  placeholder={board().format.text.split("\n")[0]}
                />
                <Show when={formatError()}>
                  {(err) => <div class="field-error">{err()}</div>}
                </Show>
              </Show>
              <Show when={!overrideFormat()}>
                <div class="field-hint">Using: {board().format.text.split("\n")[0]}</div>
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
