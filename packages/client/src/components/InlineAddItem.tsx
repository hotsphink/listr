import { type Component, createSignal, Show } from "solid-js";

export const DUMMY_ITEM_ID = "__inline_add__";

interface Props {
  onAdd: (title: string) => void;
  onExpand?: (title: string) => void;
  placeholder?: string;
  class?: string;
  /** Controls which HTML element is rendered. Defaults to "list" (<li>). */
  variant?: "list" | "table" | "card";
  /** colspan for the input cell in "table" variant. */
  colspan?: number;
}

const InlineAddItem: Component<Props> = (props) => {
  const [title, setTitle] = createSignal("");

  const submit = () => {
    const t = title().trim();
    if (!t) return;
    props.onAdd(t);
    setTitle("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  };

  // Created once; reactive bindings (value, onInput, etc.) are set up at creation.
  const inputEl = (
    <input
      type="text"
      class="inline-add-input"
      placeholder={props.placeholder ?? "Add item…"}
      value={title()}
      onInput={(e) => setTitle(e.currentTarget.value)}
      onKeyDown={handleKeyDown}
      autocapitalize="words"
    />
  );

  const expandBtn = (
    <Show when={props.onExpand}>
      <button
        class="btn-icon btn-icon-sm btn-icon-quiet inline-add-btn"
        onClick={() => props.onExpand!(title())}
        title="More options"
      >
        <ExpandIcon />
      </button>
    </Show>
  );

  if (props.variant === "table") {
    return (
      <tr data-item-id={DUMMY_ITEM_ID} class="inline-add-item">
        <td class="drag-handle-cell">
          <span class="drag-handle" title="Drag to position">⠿</span>
        </td>
        <td colspan={props.colspan ?? 1}>
          {inputEl}{expandBtn}
        </td>
      </tr>
    );
  }

  if (props.variant === "card") {
    return (
      <div
        data-item-id={DUMMY_ITEM_ID}
        class={`panel card inline-add-item${props.class ? ` ${props.class}` : ""}`}
      >
        <span class="drag-handle card-drag-handle" title="Drag to position">⠿</span>
        {inputEl}{expandBtn}
      </div>
    );
  }

  return (
    <li
      class={`list-view-item inline-add-item${props.class ? ` ${props.class}` : ""}`}
      data-item-id={DUMMY_ITEM_ID}
    >
      <span class="drag-handle" title="Drag to position">⠿</span>
      {inputEl}{expandBtn}
    </li>
  );
};

const ExpandIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
    <rect x="2" y="6" width="8" height="8" rx="1.5" stroke-width="1.5" />
    <path d="M9.5 2h4.5v4.5" stroke-width="1.5" />
    <line x1="8" y1="8" x2="14" y2="2" stroke-width="1.5" />
  </svg>
);

export default InlineAddItem;
