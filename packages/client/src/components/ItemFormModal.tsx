import { type Component, createSignal, createEffect, For } from "solid-js";
import type { AttributeDefinition, Item } from "@listr/shared";
import Modal from "./Modal.js";
import AttributeEditor from "./AttributeEditor.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { title: string; attributes: Record<string, unknown> }) => void;
  onDelete?: () => void;
  schema: AttributeDefinition[];
  initial?: Item;
}

const ItemFormModal: Component<Props> = (props) => {
  const [title, setTitle] = createSignal("");
  const [attributes, setAttributes] = createSignal<Record<string, unknown>>({});

  createEffect(() => {
    if (props.open) {
      setTitle(props.initial?.title ?? "");
      setAttributes(props.initial?.attributes ? { ...props.initial.attributes } : {});
    }
  });

  const setAttribute = (key: string, value: unknown) => {
    setAttributes((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!title().trim()) return;
    props.onSave({ title: title().trim(), attributes: attributes() });
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit Item" : "New Item"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field">
          <label>Title</label>
          <input
            value={title()}
            onInput={(e) => setTitle(e.currentTarget.value)}
            autocapitalize="words"
            autofocus
          />
        </div>
        <For each={props.schema}>
          {(def) => (
            <div class="form-field">
              <label>{def.label || def.key}</label>
              <AttributeEditor
                definition={def}
                value={attributes()[def.key]}
                onChange={(v) => setAttribute(def.key, v)}
              />
            </div>
          )}
        </For>
        <div class="modal-actions">
          {props.initial && props.onDelete && (
            <button
              type="button"
              class="btn-danger"
              style="margin-right: auto"
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
