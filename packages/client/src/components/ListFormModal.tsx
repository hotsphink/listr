import { type Component, createSignal, createEffect } from "solid-js";
import type { AttributeDefinition, List } from "@listr/shared";
import Modal from "./Modal.js";
import SchemaEditor from "./SchemaEditor.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; format_string: string; schema: AttributeDefinition[] }) => void;
  initial?: List;
}

const ListFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [formatStr, setFormatStr] = createSignal("{title}");
  const [schema, setSchema] = createSignal<AttributeDefinition[]>([]);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setFormatStr(props.initial?.format_string ?? "{title}");
      setSchema(props.initial?.schema ?? []);
    }
  });

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim()) return;
    props.onSave({
      name: name().trim(),
      format_string: formatStr(),
      schema: schema(),
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
          <label>Format String</label>
          <input
            value={formatStr()}
            onInput={(e) => setFormatStr(e.currentTarget.value)}
            placeholder="{title}"
          />
          <div style="font-size: 11px; color: var(--text-dim); margin-top: 2px">
            Available: {"{title}"}, {schema().map((a) => `{${a.key}}`).join(", ") || "add attributes below"}
          </div>
        </div>
        <div class="form-field">
          <label>Attributes</label>
          <SchemaEditor schema={schema()} onChange={setSchema} />
        </div>
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
