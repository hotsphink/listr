import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import { formatDurationShort, isSet, type AttributeDefinition, type AttributeType, type Item, type Overlay } from "@listr/shared";
import Modal from "./Modal.js";
import AttributeEditor, { showsPlaceholder } from "./AttributeEditor.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { title: string; attributes: Record<string, unknown> }) => void;
  onDelete?: () => void;
  schema: AttributeDefinition[];
  initial?: Item;
  initialTitle?: string;
  /** Integration values shown where the user has none. They are hints and are never saved. */
  overlay?: Overlay;
  /** Display name of the integration each overlay value came from, by attribute key. */
  overlaySources?: Record<string, string>;
}

let seq = 0;

/** An integration value as text, for a placeholder or a note. */
function formatOverlayValue(v: unknown, type: AttributeType): string {
  if (Array.isArray(v)) return v.join(", ");
  if (type === "duration" && typeof v === "number") return formatDurationShort(v);
  if (type === "boolean") return v ? "Yes" : "No";
  return String(v);
}

const ItemFormModal: Component<Props> = (props) => {
  // Per-instance id prefix, so each label points at its own control even with
  // two of these modals mounted at once.
  const uid = `item-form-${++seq}`;
  const fieldId = (key: string) => `${uid}-${key}`;
  const [title, setTitle] = createSignal("");
  const [attributes, setAttributes] = createSignal<Record<string, unknown>>({});

  createEffect(() => {
    if (props.open) {
      setTitle(props.initial?.title ?? props.initialTitle ?? "");
      setAttributes(props.initial?.attributes ? { ...props.initial.attributes } : {});
    }
  });

  const setAttribute = (key: string, value: unknown) => {
    setAttributes((prev) => ({ ...prev, [key]: value }));
  };

  /** The integration value a field shows while the user has none of their own, if any. */
  const shownOverlay = (key: string, own: unknown): unknown =>
    !isSet(typeof own === "string" ? own.trim() : own) && isSet(props.overlay?.[key]) ? props.overlay![key] : undefined;

  const source = (key: string) => props.overlaySources?.[key] ?? "an integration";

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!title().trim() && !isSet(props.overlay?.title)) return;
    props.onSave({ title: title().trim(), attributes: attributes() });
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit Item" : "New Item"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field" classList={{ "from-integration": shownOverlay("title", title()) !== undefined }}>
          <label class="field-label" for={`${uid}-title`}>Title</label>
          <input
            id={`${uid}-title`}
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            placeholder={typeof props.overlay?.title === "string" ? props.overlay.title : undefined}
            autocapitalize="words"
            autofocus
          />
          <Show when={shownOverlay("title", title()) !== undefined}>
            <div class="field-hint integration-note">From {source("title")}. Enter a title to override it.</div>
          </Show>
        </div>
        <For each={props.schema}>
          {(def) => {
            const shown = () => shownOverlay(def.key, attributes()[def.key]);
            return (
              <div class="form-field" classList={{ "from-integration": shown() !== undefined }}>
                <label class="field-label" id={`${fieldId(def.key)}-label`} for={fieldId(def.key)}>
                  {def.label || def.key}
                </label>
                <AttributeEditor
                  definition={def}
                  id={fieldId(def.key)}
                  labelledBy={`${fieldId(def.key)}-label`}
                  value={attributes()[def.key]}
                  onChange={(v) => setAttribute(def.key, v)}
                  placeholder={shown() !== undefined && showsPlaceholder(def.type) ? formatOverlayValue(shown(), def.type) : undefined}
                />
                <Show when={shown() !== undefined}>
                  <div class="field-hint integration-note">
                    {showsPlaceholder(def.type)
                      ? `From ${source(def.key)}. Enter a value to override it.`
                      : `${formatOverlayValue(shown(), def.type)}, from ${source(def.key)}. Setting a value overrides it.`}
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
        <div class="actions">
          {props.initial && props.onDelete && (
            <button
              type="button"
              class="btn-danger action-lead"
              onClick={props.onDelete}
            >
              Delete
            </button>
          )}
          <button type="button" class="btn-ghost" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" class="btn-primary">
            {props.initial ? "Save" : "Add"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default ItemFormModal;
