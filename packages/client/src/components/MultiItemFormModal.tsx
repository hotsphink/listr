import { type Component, createSignal, createEffect, For } from "solid-js";
import type { AttributeDefinition } from "@listr/shared";
import Modal from "./Modal.js";
import AttributeEditor from "./AttributeEditor.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (updates: Record<string, unknown>) => void;
  schema: AttributeDefinition[];
  count: number;
}

const MultiItemFormModal: Component<Props> = (props) => {
  const [states, setStates] = createSignal<Record<string, { checked: boolean; value: unknown }>>({});

  createEffect(() => {
    if (props.open) {
      setStates(Object.fromEntries(
        props.schema.map((def) => [def.key, { checked: false, value: null as unknown }])
      ));
    }
  });

  const setChecked = (key: string, checked: boolean) =>
    setStates((prev) => ({ ...prev, [key]: { ...prev[key], checked } }));

  const setValue = (key: string, value: unknown) =>
    setStates((prev) => ({ ...prev, [key]: { checked: true, value } }));

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    const updates: Record<string, unknown> = {};
    for (const [key, state] of Object.entries(states())) {
      if (state.checked) updates[key] = state.value;
    }
    props.onSave(updates);
  };

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>Edit {props.count} Items</h2>
      <form onSubmit={handleSubmit}>
        <For each={props.schema}>
          {(def) => {
            const state = () => states()[def.key] ?? { checked: false, value: null };
            return (
              <div class="multi-edit-field">
                <label class="multi-edit-label">
                  <input
                    type="checkbox"
                    checked={state().checked}
                    onChange={(e) => setChecked(def.key, e.currentTarget.checked)}
                  />
                  <span>{def.label || def.key}</span>
                </label>
                <div class="multi-edit-input">
                  <AttributeEditor
                    definition={def}
                    value={state().value}
                    onChange={(v) => setValue(def.key, v)}
                  />
                </div>
              </div>
            );
          }}
        </For>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
};

export default MultiItemFormModal;
