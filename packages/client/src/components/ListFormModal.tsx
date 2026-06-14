import { type Component, createSignal, createEffect, For, Show } from "solid-js";
import type { Category, List } from "@listr/shared";
import Modal from "./Modal.js";

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: { name: string; category_id: string | null; format_string: string | null }) => void;
  categories: Category[];
  initial?: List;
  defaultCategoryId?: string | null;
}

const ListFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [categoryId, setCategoryId] = createSignal<string | null>(null);
  const [formatOverride, setFormatOverride] = createSignal("");
  const [overrideFormat, setOverrideFormat] = createSignal(false);

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setCategoryId(props.initial?.category_id ?? props.defaultCategoryId ?? null);
      const hasOverride = props.initial?.format_string != null;
      setOverrideFormat(hasOverride);
      setFormatOverride(props.initial?.format_string ?? "");
    }
  });

  const selectedCategory = () => props.categories.find((c) => c.id === categoryId());

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim()) return;
    props.onSave({
      name: name().trim(),
      category_id: categoryId(),
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
          <label>Category</label>
          <select
            value={categoryId() ?? ""}
            onChange={(e) => setCategoryId(e.currentTarget.value || null)}
          >
            <option value="">None</option>
            <For each={props.categories}>
              {(cat) => <option value={cat.id}>{cat.name}</option>}
            </For>
          </select>
        </div>
        <Show when={selectedCategory()}>
          {(cat) => (
            <div class="form-field">
              <div class="checkbox-field">
                <input
                  type="checkbox"
                  checked={overrideFormat()}
                  onChange={(e) => {
                    setOverrideFormat(e.currentTarget.checked);
                    if (e.currentTarget.checked && !formatOverride()) {
                      setFormatOverride(cat().format_string);
                    }
                  }}
                />
                <label style="margin-bottom: 0; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text)">
                  Override category format string
                </label>
              </div>
              <Show when={overrideFormat()}>
                <input
                  value={formatOverride()}
                  onInput={(e) => setFormatOverride(e.currentTarget.value)}
                  placeholder={cat().format_string}
                />
              </Show>
              <Show when={!overrideFormat()}>
                <div style="font-size: 12px; color: var(--text-muted)">
                  Using: {cat().format_string}
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
