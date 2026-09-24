import { type Component, For, Show, createMemo } from "solid-js";
import type { IntegrationChoice, IntegrationResult, Item } from "@listr/shared";
import Modal from "./Modal.js";

interface Props {
  /** The item to choose for. Closed when undefined. */
  item: Item | undefined;
  /** The item's results, in priority order. */
  results: IntegrationResult[];
  onClose: () => void;
  onPick: (attr: string, choice: IntegrationChoice, value: string) => void;
}

/** Lets the user pick among an integration's options for an ambiguous item. */
const IntegrationChoiceModal: Component<Props> = (props) => {
  // Offer the choices of the first result that still needs one.
  const pending = createMemo(() => {
    for (const r of props.results) {
      if (r.status !== "ambiguous" || !r.choices) continue;
      const [attr, choice] = Object.entries(r.choices)[0] ?? [];
      if (attr && choice) return { attr, choice };
    }
    return null;
  });

  return (
    <Modal open={props.item !== undefined && pending() !== null} onClose={props.onClose}>
      <div class="header-row">
        <h2>Choose a match</h2>
        <button type="button" class="btn-icon" onClick={props.onClose} aria-label="Cancel">{"\u2715"}</button>
      </div>
      <Show when={pending()}>
        {(p) => (
          <div class="move-to-list-groups">
            <For each={p().choice.options}>
              {(option) => (
                <button type="button" class="move-to-list-item" onClick={() => props.onPick(p().attr, p().choice, option.value)}>
                  {option.label}
                </button>
              )}
            </For>
          </div>
        )}
      </Show>
    </Modal>
  );
};

export default IntegrationChoiceModal;
