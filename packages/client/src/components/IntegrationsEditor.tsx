import { type Component, Index, Show, createSignal } from "solid-js";
import type { Integration } from "@listr/shared";

interface Props {
  integrations: Integration[];
  onChange: (integrations: Integration[]) => void;
}

const IntegrationsEditor: Component<Props> = (props) => {
  const add = () => {
    props.onChange([...props.integrations, { integration_id: "", enabled: true }]);
  };

  const updateAt = (index: number, updates: Partial<Integration>) => {
    props.onChange(props.integrations.map((item, i) => i === index ? { ...item, ...updates } : item));
  };

  const removeAt = (index: number) => {
    props.onChange(props.integrations.filter((_, i) => i !== index));
  };

  const setConfig = (index: number, json: string) => {
    try {
      const config = json.trim() ? JSON.parse(json) : undefined;
      updateAt(index, { config });
    } catch {
      // invalid JSON — ignore until blur
    }
  };

  return (
    <div>
      <Index each={props.integrations}>
        {(integration, i) => (
          <IntegrationEntry
            integration={integration()}
            index={i}
            onUpdate={(updates) => updateAt(i, updates)}
            onRemove={() => removeAt(i)}
            onConfig={(json) => setConfig(i, json)}
          />
        )}
      </Index>
      <button type="button" class="btn-ghost" onClick={add}>
        + Add integration
      </button>
    </div>
  );
};

interface EntryProps {
  integration: Integration;
  index: number;
  onUpdate: (updates: Partial<Integration>) => void;
  onRemove: () => void;
  onConfig: (json: string) => void;
}

const IntegrationEntry: Component<EntryProps> = (props) => {
  const [showConfig, setShowConfig] = createSignal(
    props.integration.config != null && Object.keys(props.integration.config).length > 0
  );
  const [configText, setConfigText] = createSignal(
    props.integration.config ? JSON.stringify(props.integration.config, null, 2) : ""
  );

  return (
    <div class="integration-entry">
      <div class="integration-entry-main">
        <input
          class="integration-id"
          placeholder="Integration ID (e.g. omdb)"
          value={props.integration.integration_id}
          onBlur={(e) => props.onUpdate({ integration_id: e.currentTarget.value })}
        />
        <label class="integration-enabled-label">
          <input
            type="checkbox"
            checked={props.integration.enabled}
            onChange={(e) => props.onUpdate({ enabled: e.currentTarget.checked })}
          />
          Enabled
        </label>
        <button
          type="button"
          class="btn-ghost btn-xs"
          onClick={() => setShowConfig((v) => !v)}
          title="Toggle config"
        >
          Config
        </button>
        <button type="button" class="btn-icon" onClick={props.onRemove} title="Remove integration">
          ×
        </button>
      </div>
      <Show when={showConfig()}>
        <textarea
          class="integration-config-textarea"
          placeholder="{}"
          rows={3}
          value={configText()}
          onInput={(e) => {
            setConfigText(e.currentTarget.value);
            props.onConfig(e.currentTarget.value);
          }}
          spellcheck={false}
        />
      </Show>
    </div>
  );
};

export default IntegrationsEditor;
