import { type Component, Show, createEffect, createSignal } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { Board } from "@listr/shared";
import Modal from "./Modal.js";
import { cloneBoard, type CloneBoardOptions } from "../db/operations.js";

interface Props {
  /** The board to clone. Closed when undefined. */
  board: Board | undefined;
  onClose: () => void;
}

let seq = 0;

/** Asks what to copy, then clones the board and opens the clone. */
const CloneBoardModal: Component<Props> = (props) => {
  const navigate = useNavigate();
  const uid = `clone-board-${++seq}`;
  const [name, setName] = createSignal("");
  const [integrations, setIntegrations] = createSignal<CloneBoardOptions["integrations"]>("copy");
  const [lists, setLists] = createSignal<CloneBoardOptions["lists"]>("names");
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  // Disabled integrations count too: cloning copies their config.
  const hasIntegrations = () => (props.board?.integrations ?? []).length > 0;
  const hasEnabledIntegrations = () => (props.board?.integrations ?? []).some((c) => c.enabled);

  createEffect(() => {
    const b = props.board;
    if (!b) return;
    setName(`Clone of ${b.name}`);
    setIntegrations("copy");
    setLists("names");
    setError(null);
    setSaving(false);
  });

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const b = props.board;
    const trimmed = name().trim();
    if (!b) return;
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setSaving(true);
    try {
      const clone = await cloneBoard(b.id, { name: trimmed, integrations: hasIntegrations() ? integrations() : "none", lists: lists() });
      props.onClose();
      navigate(`/board/${clone.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed. Check that your browser allows storage.");
      setSaving(false);
    }
  };

  return (
    <Modal open={props.board !== undefined} onClose={props.onClose}>
      <h2>Clone board</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-field">
          <label class="field-label" for={`${uid}-name`}>Name</label>
          <input id={`${uid}-name`} value={name()} onInput={(e) => { setName(e.currentTarget.value); setError(null); }} autofocus />
        </div>
        <div class="field-hint field-hint-lead">The clone gets this board's attributes and format.</div>
        <fieldset class="form-field clone-options">
          <legend class="field-label">Lists</legend>
          <label class="check-label">
            <input type="radio" name={`${uid}-lists`} checked={lists() === "none"} onChange={() => setLists("none")} />
            No lists
          </label>
          <label class="check-label">
            <input type="radio" name={`${uid}-lists`} checked={lists() === "names"} onChange={() => setLists("names")} />
            List names only
          </label>
          <label class="check-label">
            <input type="radio" name={`${uid}-lists`} checked={lists() === "items"} onChange={() => setLists("items")} />
            Lists and their items
          </label>
        </fieldset>
        <Show when={hasIntegrations()}>
          <fieldset class="form-field clone-options">
            <legend class="field-label">Integrations</legend>
            <label class="check-label">
              <input type="radio" name={`${uid}-integrations`} checked={integrations() === "none"} onChange={() => setIntegrations("none")} />
              No integrations
            </label>
            <label class="check-label">
              <input type="radio" name={`${uid}-integrations`} checked={integrations() === "copy"} onChange={() => setIntegrations("copy")} />
              Integrations as they are
            </label>
            <label class="check-label">
              <input type="radio" name={`${uid}-integrations`} checked={integrations() === "disabled"} onChange={() => setIntegrations("disabled")} />
              Integrations, all disabled
            </label>
            <Show when={integrations() === "copy" && hasEnabledIntegrations() && lists() === "items"}>
              <div class="field-hint">Every cloned item is looked up again, which uses the integration's API calls.</div>
            </Show>
          </fieldset>
        </Show>
        <Show when={error()}>
          <div class="field-error" role="alert">{error()}</div>
        </Show>
        <div class="actions">
          <button type="button" class="btn-ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={saving()}>{saving() ? "Cloning..." : "Clone"}</button>
        </div>
      </form>
    </Modal>
  );
};

export default CloneBoardModal;
