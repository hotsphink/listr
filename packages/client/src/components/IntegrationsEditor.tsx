import { type Component, For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { parse as parseToml } from "smol-toml";
import { addMissingSettings, type AttributeDefinition, type Integration, type IntegrationInfo } from "@listr/shared";

interface Props {
  integrations: Integration[];
  onChange: (integrations: Integration[]) => void;
  /** Modules the server offers. */
  available: IntegrationInfo[];
  schema: AttributeDefinition[];
  /** Add a module's attributes to the board schema. */
  onAddAttributes: (attrs: IntegrationInfo["attributes"]) => void;
  /** Called with false while any row's TOML is invalid. */
  onValidityChange: (valid: boolean) => void;
}

interface Row {
  /** Stable local key, so a row keeps its own state when rows above it go away. */
  uid: number;
  value: Integration;
}

let nextUid = 0;

/** The TOML parse error for a config, or null when it parses. */
export function tomlError(text: string | undefined): string | null {
  if (!text) return null;
  try {
    parseToml(text);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message.split("\n")[0] : String(err);
  }
}

const IntegrationsEditor: Component<Props> = (props) => {
  const [rows, setRows] = createSignal<Row[]>([]);
  let emitted: Integration[] | null = null;

  // Rebuild rows only when the parent hands in a list this editor didn't produce.
  createEffect(() => {
    const incoming = props.integrations;
    if (incoming === emitted) return;
    setRows(incoming.map((value) => ({ uid: ++nextUid, value })));
  });

  createEffect(() => props.onValidityChange(rows().every((r) => tomlError(r.value.config) === null)));

  const emit = (next: Row[]) => {
    setRows(next);
    emitted = next.map((r) => r.value);
    props.onChange(emitted);
  };

  const info = (id: string) => props.available.find((m) => m.id === id);

  // Rows are keyed by uid, so editing a row keeps its DOM and focus.
  const uids = createMemo(() => rows().map((r) => r.uid));

  const unused = createMemo(() => props.available.filter((m) => !rows().some((r) => r.value.integration_id === m.id)));

  const add = () => {
    const module = unused()[0];
    if (!module) return;
    emit([...rows(), { uid: ++nextUid, value: { integration_id: module.id, enabled: true, config: module.config_template } }]);
  };

  const update = (uid: number, updates: Partial<Integration>) =>
    emit(rows().map((r) => (r.uid === uid ? { ...r, value: { ...r.value, ...updates } } : r)));

  const remove = (uid: number) => emit(rows().filter((r) => r.uid !== uid));

  // Moving a row up gives its module priority when two modules fill the same attribute.
  const moveUp = (uid: number) => {
    const list = [...rows()];
    const i = list.findIndex((r) => r.uid === uid);
    if (i <= 0) return;
    [list[i - 1], list[i]] = [list[i], list[i - 1]];
    emit(list);
  };

  const switchModule = (row: Row, id: string) => {
    const previous = info(row.value.integration_id);
    const untouched = !row.value.config || row.value.config === previous?.config_template;
    update(row.uid, { integration_id: id, ...(untouched ? { config: info(id)?.config_template ?? "" } : {}) });
  };

  return (
    <div>
      <For each={uids()}>
        {(uid, index) => {
          // Keep the last row seen, so reads during this row's removal still resolve.
          let last: Row | undefined;
          const row = () => (last = rows().find((r) => r.uid === uid) ?? last)!;
          const module = () => info(row().value.integration_id);
          const error = () => tomlError(row().value.config);
          const missingAttrs = () => (module()?.attributes ?? []).filter((a) => !props.schema.some((s) => s.key === a.key));
          return (
            <div class="integration-entry">
              <div class="control-row">
                <Show
                  when={module()}
                  fallback={<span class="integration-id">unknown: {row().value.integration_id}</span>}
                >
                  <select
                    class="integration-id"
                    aria-label="Integration"
                    value={row().value.integration_id}
                    onChange={(e) => switchModule(row(), e.currentTarget.value)}
                  >
                    <For each={[module()!, ...unused()]}>
                      {(m) => <option value={m.id}>{m.name}</option>}
                    </For>
                  </select>
                </Show>
                <label class="check-label">
                  <input
                    type="checkbox"
                    checked={row().value.enabled}
                    disabled={!module()}
                    onChange={(e) => update(uid, { enabled: e.currentTarget.checked })}
                  />
                  Enabled
                </label>
                <Show when={index() > 0}>
                  <button type="button" class="btn-ghost btn-xs" onClick={() => moveUp(uid)} title="Give this integration priority">
                    Move up
                  </button>
                </Show>
                <button
                  type="button"
                  class="btn-icon"
                  onClick={() => remove(uid)}
                  title="Remove integration"
                  aria-label={`Remove integration ${module()?.name ?? row().value.integration_id}`}
                >
                  <span aria-hidden="true">{"\u00d7"}</span>
                </button>
              </div>
              <Show when={module() && !module()!.active}>
                <div class="field-warning" role="status">This integration isn't active on the server right now, for example because its API key is missing.</div>
              </Show>
              <Show when={!module()}>
                <div class="field-hint">This server doesn't offer this integration. Its config is kept.</div>
              </Show>
              <Show when={module()}>
                <textarea
                  class="integration-config-textarea textarea-code"
                  aria-label={`${module()!.name} config, as TOML`}
                  aria-invalid={error() !== null}
                  rows={5}
                  value={row().value.config ?? ""}
                  onInput={(e) => update(uid, { config: e.currentTarget.value })}
                  spellcheck={false}
                />
                <Show when={error()}>
                  <div class="field-error" role="alert">TOML error: {error()}</div>
                </Show>
                <div class="control-row">
                  <button
                    type="button"
                    class="btn-ghost btn-xs"
                    onClick={() => update(uid, { config: addMissingSettings(row().value.config ?? "", module()!.config_template) })}
                  >
                    Add missing settings
                  </button>
                  <Show when={missingAttrs().length > 0}>
                    <button type="button" class="btn-ghost btn-xs" onClick={() => props.onAddAttributes(missingAttrs())}>
                      Add {module()!.name} attributes to schema
                    </button>
                  </Show>
                </div>
              </Show>
            </div>
          );
        }}
      </For>
      <Show
        when={unused().length > 0}
        fallback={<Show when={props.available.length === 0}><div class="field-hint">No integrations are available from the server.</div></Show>}
      >
        <button type="button" class="btn-ghost" onClick={add}>
          + Add integration
        </button>
      </Show>
    </div>
  );
};

export default IntegrationsEditor;
