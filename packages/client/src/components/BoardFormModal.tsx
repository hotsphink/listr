import { type Component, createSignal, createEffect, createMemo, Show } from "solid-js";
import { compileFormat, FORMAT_VERSION, type AttributeDefinition, type Board, type FormatSpec, type Integration, type Item } from "@listr/shared";
import Modal from "./Modal.js";
import SchemaEditor from "./SchemaEditor.js";
import IntegrationsEditor from "./IntegrationsEditor.js";
import FormatEditor, { formatHasErrors, rankSampleItems } from "./FormatEditor.js";
import { db } from "../db/database.js";
import { availableIntegrations } from "../store/integrationCatalog.js";

function generateFormat(schema: AttributeDefinition[]): string {
  return ["[title]", ...schema.map((a) => `?[${a.key}]`)].join(" ");
}

interface ListOverride {
  name: string;
  text: string;
  /** Whether the override compiled cleanly against the board as saved. */
  okBefore: boolean;
}

/** The board's lists that have their own format, for spotting edits that break them. */
async function listOverridesForBoard(board: Board): Promise<ListOverride[]> {
  const lists = await db.lists.where("board_id").equals(board.id).sortBy("position");
  return lists.flatMap((l) => l.format == null ? [] : [{
    name: l.name,
    text: l.format.text,
    okBefore: !compileFormat(l.format.text, board.schema, board.format.text).hasErrors,
  }]);
}

/** The board's items, ranked for the format preview. */
async function sampleItemsForBoard(boardId: string): Promise<Item[]> {
  const listIds = await db.lists.where("board_id").equals(boardId).primaryKeys();
  return rankSampleItems(await db.items.where("list_id").anyOf(listIds).toArray());
}

function brokenListsMessage(names: string[]): string {
  const quoted = names.map((n) => `"${n}"`).join(", ");
  return names.length === 1
    ? `These changes break the custom format of list ${quoted}.`
    : `These changes break the custom formats of lists ${quoted}.`;
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
  const [sampleItems, setSampleItems] = createSignal<Item[]>([]);
  const [listOverrides, setListOverrides] = createSignal<ListOverride[]>([]);
  const [schema, setSchema] = createSignal<AttributeDefinition[]>([]);
  const [boardSyncKey, setBoardSyncKey] = createSignal("");
  const [integrations, setIntegrations] = createSignal<Integration[]>([]);
  const [integrationsValid, setIntegrationsValid] = createSignal(true);
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
      setSampleItems([]);
      setListOverrides([]);
      if (props.initial) {
        sampleItemsForBoard(props.initial.id).then(setSampleItems).catch(console.error);
        listOverridesForBoard(props.initial).then(setListOverrides).catch(console.error);
      }
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

  const addIntegrationAttributes = (attrs: { key: string; type: AttributeDefinition["type"]; label: string }[]) => {
    const current = schema();
    const start = current.reduce((max, a) => Math.max(max, a.position), -1) + 1;
    handleSchemaChange([
      ...current,
      ...attrs
        .filter((a) => !current.some((c) => c.key === a.key))
        .map((a, i) => ({ key: a.key, label: a.label, type: a.type, required: false, position: start + i })),
    ]);
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

    if (!integrationsValid()) {
      setSaveError("Fix the integration config errors before saving.");
      return;
    }
    if (formatHasErrors(formatText(), schema())) {
      setFormatError("Fix the errors in the format before saving.");
      return;
    }
    const broken = brokenLists();
    if (broken.length > 0 && !confirm(`${brokenListsMessage(broken)} Save anyway?`)) return;

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

  // Lists whose own format worked with the saved board but not with these edits.
  const brokenLists = createMemo(() => listOverrides()
    .filter((l) => l.okBefore && compileFormat(l.text, schema(), formatText()).hasErrors)
    .map((l) => l.name));

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
            sampleItems={sampleItems()}
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
            <IntegrationsEditor
              integrations={integrations()}
              onChange={setIntegrations}
              available={availableIntegrations()}
              schema={schema()}
              onAddAttributes={addIntegrationAttributes}
              onValidityChange={setIntegrationsValid}
            />
          </div>
        </div>
        <Show when={brokenLists().length > 0}>
          <div class="field-warning" role="status">{brokenListsMessage(brokenLists())}</div>
        </Show>
        <Show when={saveError()}>
          {(err) => <div class="field-error" role="alert">{err()}</div>}
        </Show>
        <div class="actions">
          <button type="button" class="btn-ghost" onClick={props.onClose} disabled={saving()}>
            Cancel
          </button>
          <button type="submit" class="btn-primary" disabled={saving() || !integrationsValid()}>
            {saving() ? "Saving..." : props.initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default BoardFormModal;
