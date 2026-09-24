import { type Component, For, Show, createMemo } from "solid-js";
import type { IntegrationChoice, IntegrationResult, Item, Overlay } from "@listr/shared";
import Modal from "./Modal.js";

interface Props {
  /** The item to choose for. Closed when undefined. */
  item: Item | undefined;
  /** The item's results, in priority order. */
  results: IntegrationResult[];
  /** The item's overlay, to mark the option that currently shows. */
  current?: Overlay;
  onClose: () => void;
  onPick: (attr: string, choice: IntegrationChoice, value: string) => void;
}

/** Lets the user pick among an integration's options, to resolve an ambiguous match or replace one. */
const IntegrationChoiceModal: Component<Props> = (props) => {
  // Offer a result that still needs a choice first, else any result that has options.
  const pending = createMemo(() => {
    const withChoices = props.results.filter((r) => r.choices && Object.keys(r.choices).length > 0);
    const r = withChoices.find((x) => x.status === "ambiguous") ?? withChoices[0];
    if (!r) return null;
    const [attr, choice] = Object.entries(r.choices!)[0];
    return { attr, choice };
  });

  const isCurrent = (attr: string, value: string) => {
    const shown = props.item?.attributes[attr] ?? props.current?.[attr];
    return shown === value;
  };

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
                <button
                  type="button"
                  class="move-to-list-item"
                  aria-current={isCurrent(p().attr, option.value) ? "true" : undefined}
                  onClick={() => props.onPick(p().attr, p().choice, option.value)}
                >
                  {option.label}
                  <Show when={isCurrent(p().attr, option.value)}>
                    <span class="field-hint"> (current)</span>
                  </Show>
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
