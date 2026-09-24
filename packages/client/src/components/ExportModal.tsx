import { type Component, Show, createEffect, createSignal } from "solid-js";
import Modal from "./Modal.js";
import { DEFAULT_EXPORT_OPTIONS } from "../db/exportImport.js";
import { pendingExport, runExport, setPendingExport } from "../store/exportRequest.js";

/** Asks what an export carries from integrations, then downloads it. */
const ExportModal: Component = () => {
  const [integrations, setIntegrations] = createSignal(DEFAULT_EXPORT_OPTIONS.integrations);
  const [integrationValues, setIntegrationValues] = createSignal(DEFAULT_EXPORT_OPTIONS.integrationValues);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (!pendingExport()) return;
    setIntegrations(DEFAULT_EXPORT_OPTIONS.integrations);
    setIntegrationValues(DEFAULT_EXPORT_OPTIONS.integrationValues);
    setError(null);
    setBusy(false);
  });

  const title = () => {
    const scope = pendingExport();
    return !scope ? "" : scope.type === "all" ? "Export all boards" : `Export "${scope.name}"`;
  };

  const close = () => setPendingExport(null);

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    const scope = pendingExport();
    if (!scope) return;
    setBusy(true);
    try {
      await runExport(scope, { integrations: integrations(), integrationValues: integrationValues() });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <Modal open={pendingExport() !== null} onClose={close}>
      <h2>{title()}</h2>
      <form onSubmit={handleSubmit}>
        <fieldset class="form-field clone-options">
          <legend class="field-label">Integrations</legend>
          <div class="export-option">
            <label class="check-label">
              <input type="checkbox" checked={integrations()} onChange={(e) => setIntegrations(e.currentTarget.checked)} />
              Integration settings
            </label>
            <div class="field-hint">Which integrations each board uses, their config, and how their values map to attributes.</div>
          </div>
          <div class="export-option">
            <label class="check-label">
              <input type="checkbox" checked={integrationValues()} onChange={(e) => setIntegrationValues(e.currentTarget.checked)} />
              Values integrations filled in
            </label>
            <div class="field-hint">
              Written into items as ordinary values. After an import they count as your own and override the integration.
            </div>
          </div>
        </fieldset>
        <Show when={error()}>
          <div class="field-error" role="alert">{error()}</div>
        </Show>
        <div class="actions">
          <button type="button" class="btn-ghost" onClick={close}>Cancel</button>
          <button type="submit" class="btn-primary" disabled={busy()}>Export</button>
        </div>
      </form>
    </Modal>
  );
};

export default ExportModal;
