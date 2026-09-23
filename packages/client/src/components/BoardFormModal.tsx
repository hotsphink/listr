import { type Component, createSignal, createEffect, Show } from "solid-js";
import { FORMAT_VERSION, type AttributeDefinition, type Board, type FormatSpec, type Integration, type Item } from "@listr/shared";
import Modal from "./Modal.js";
import SchemaEditor from "./SchemaEditor.js";
import IntegrationsEditor from "./IntegrationsEditor.js";
import FormatEditor, { formatHasErrors } from "./FormatEditor.js";
import { db } from "../db/database.js";

function generateFormat(schema: AttributeDefinition[]): string {
  return ["[title]", ...schema.map((a) => `?[${a.key}]`)].join(" ");
}

/** The first item of the board's first list, for the format preview. */
export async function sampleItemForBoard(boardId: string): Promise<Item | undefined> {
  const lists = await db.lists.where("board_id").equals(boardId).sortBy("position");
  for (const list of lists) {
    const item = await db.items.where("list_id").equals(list.id).first();
    if (item) return item;
  }
  return undefined;
}

export interface BoardFormData {
  name: string;
  color: string;
  format: FormatSpec;
  schema: AttributeDefinition[];
  sync_key: string;
  integrations: Integration[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: BoardFormData) => Promise<void> | void;
  initial?: Board;
  /** Pre-fill the share key when creating a new board (e.g. starting a fresh board group). Ignored when editing. */
  defaultSyncKey?: string;
}

let seq = 0;

const BoardFormModal: Component<Props> = (props) => {
  const uid = `board-form-${++seq}`;
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal("#5b8def");
  const [formatText, setFormatText] = createSignal("[title]");
  const [sampleItem, setSampleItem] = createSignal<Item | undefined>();
  const [schema, setSchema] = createSignal<AttributeDefinition[]>([]);
  const [boardSyncKey, setBoardSyncKey] = createSignal("");
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);
  const [formatManuallyEdited, setFormatManuallyEdited] = createSignal(false);
  const [nameError, setNameError] = createSignal<string | null>(null);
  const [formatError, setFormatError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setColor(props.initial?.color ?? "#5b8def");
      setFormatText(props.initial?.format.text ?? "[title]");
      setSampleItem(undefined);
      if (props.initial) sampleItemForBoard(props.initial.id).then(setSampleItem).catch(console.error);
      setSchema(props.initial?.schema ?? []);
      setBoardSyncKey(props.initial?.sync_key ?? props.defaultSyncKey ?? "");
      setIntegrations(props.initial?.integrations ?? []);
      setFormatManuallyEdited(!!props.initial);
      setNameError(null);
      setFormatError(null);
      setSaveError(null);
      setSaving(false);
    }
  });

  const handleSchemaChange = (newSchema: AttributeDefinition[]) => {
    setSchema(newSchema);
    if (!formatManuallyEdited()) setFormatText(generateFormat(newSchema));
  };

  const handleFormatInput = (value: string) => {
    setFormatText(value);
    setFormatManuallyEdited(true);
    setFormatError(null);
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSaveError(null);

    const nameValue = name().trim();
    if (!nameValue) {
      setNameError("Name is required");
      return;
    }
    setNameError(null);

    if (formatHasErrors(formatText(), schema())) {
      setFormatError("Fix the errors in the format before saving.");
      return;
    }

    setSaving(true);
    try {
      await props.onSave({
        name: nameValue,
        color: color(),
        format: { version: FORMAT_VERSION, text: formatText() },
        schema: schema(),
        sync_key: boardSyncKey().trim(),
        integrations: integrations(),
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed. Check that your browser allows storage.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="board-form">
      <div class="modal-page-header">
        <button class="modal-page-back" type="button" onClick={props.onClose} aria-label="Back">←</button>
      </div>
      <h2>{props.initial ? "Edit Board" : props.defaultSyncKey ? "New Board Group" : "New Board"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-row">
          <div class="form-field">
            <label class="field-label" for={`${uid}-name`}>Name</label>
            <input
              id={`${uid}-name`}
              classList={{ "input-error": nameError() !== null }}
              value={name()}
              onInput={(e) => { setName(e.currentTarget.value); setNameError(null); }}
              aria-invalid={nameError() !== null}
              aria-describedby={nameError() !== null ? `${uid}-name-error` : undefined}
              autofocus
            />
            <Show when={nameError()}>
              {(err) => <div class="field-error" id={`${uid}-name-error`}>{err()}</div>}
            </Show>
          </div>
          <div class="form-field form-field-narrow">
            <label class="field-label" for={`${uid}-color`}>Color</label>
            <input
              id={`${uid}-color`}
              class="color-input"
              type="color"
              value={color()}
              onInput={(e) => setColor(e.currentTarget.value)}
            />
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for={`${uid}-share-key`}>Share Key</label>
          <input
            id={`${uid}-share-key`}
            value={boardSyncKey()}
            onInput={(e) => setBoardSyncKey(e.currentTarget.value)}
            placeholder="leave empty to use your default key"
            aria-describedby={`${uid}-share-key-hint`}
          />
          <div class="field-hint" id={`${uid}-share-key-hint`}>
            Boards with the same share key sync together. Share this key with others to collaborate.
          </div>
        </div>
        <div class="form-field">
          <label class="field-label" for={`${uid}-format`}>Format</label>
          <FormatEditor
            id={`${uid}-format`}
            value={formatText()}
            onInput={handleFormatInput}
            schema={schema()}
            sampleItem={sampleItem()}
            placeholder="[title]"
          />
          <Show when={formatError()}>
            {(err) => <div class="field-error">{err()}</div>}
          </Show>
        </div>
        <div class="form-field">
          <div class="field-label" id={`${uid}-attrs-label`}>Attributes</div>
          <div role="group" aria-labelledby={`${uid}-attrs-label`}>
            <SchemaEditor schema={schema()} onChange={handleSchemaChange} />
          </div>
        </div>
        <div class="form-field">
          <div class="field-label" id={`${uid}-integrations-label`}>Integrations</div>
          <div role="group" aria-labelledby={`${uid}-integrations-label`}>
            <IntegrationsEditor integrations={integrations()} onChange={setIntegrations} />
          </div>
        </div>
        <Show when={saveError()}>
          {(err) => <div class="field-error" role="alert">{err()}</div>}
        </Show>
        <div class="actions">
          <button type="button" class="btn-ghost" onClick={props.onClose} disabled={saving()}>
            Cancel
          </button>
          <button type="submit" class="btn-primary" disabled={saving()}>
            {saving() ? "Saving..." : props.initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default BoardFormModal;
