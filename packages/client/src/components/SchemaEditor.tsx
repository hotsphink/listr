import { type Component, For, Index, Show, Switch, Match } from "solid-js";
import type { AttributeDefinition, AttributeType } from "@listr/shared";

const ATTRIBUTE_TYPES: { value: AttributeType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "rating", label: "Rating" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "Date & Time" },
  { value: "boolean", label: "Yes/No" },
  { value: "enum", label: "Select" },
  { value: "tags", label: "Tags" },
  { value: "url", label: "URL" },
  { value: "duration", label: "Duration" },
];

interface Props {
  schema: AttributeDefinition[];
  onChange: (schema: AttributeDefinition[]) => void;
}

const SchemaEditor: Component<Props> = (props) => {
  const addAttribute = () => {
    const pos = props.schema.length;
    props.onChange([
      ...props.schema,
      {
        key: `field_${pos}`,
        label: "",
        type: "text",
        required: false,
        position: pos,
      },
    ]);
  };

  const updateAt = (index: number, updates: Partial<AttributeDefinition>) => {
    const updated = props.schema.map((attr, i) =>
      i === index ? { ...attr, ...updates } : attr,
    );
    props.onChange(updated);
  };

  const removeAt = (index: number) => {
    props.onChange(props.schema.filter((_, i) => i !== index));
  };

  return (
    <div>
      <Index each={props.schema}>
        {(attr, i) => (
          <div class="schema-entry">
            <input
              placeholder="Key"
              title="Attribute key (used in format strings)"
              value={attr().key}
              onBlur={(e) => updateAt(i, { key: e.currentTarget.value })}
              style="max-width: 100px"
            />
            <input
              placeholder="Label"
              title="Display label (shown in table headers and forms)"
              value={attr().label}
              onBlur={(e) => updateAt(i, { label: e.currentTarget.value })}
            />
            <select
              title="Attribute type"
              value={attr().type}
              onChange={(e) => {
                const newType = e.currentTarget.value as AttributeType;
                updateAt(i, { type: newType, default_value: undefined });
              }}
              style="max-width: 110px"
            >
              <For each={ATTRIBUTE_TYPES}>
                {(t) => <option value={t.value}>{t.label}</option>}
              </For>
            </select>
            {(attr().type === "enum" || attr().type === "tags") && (
              <input
                placeholder="opt1, opt2, ..."
                title="Options (comma-separated)"
                value={(attr().options ?? []).join(", ")}
                onBlur={(e) =>
                  updateAt(i, {
                    options: e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
                style="max-width: 160px"
              />
            )}
            <DefaultValueInput
              type={attr().type}
              value={attr().default_value}
              options={attr().options}
              onChange={(v) => updateAt(i, { default_value: v })}
            />
            <button type="button" class="btn-icon" onClick={() => removeAt(i)} title="Remove attribute">
              ×
            </button>
          </div>
        )}
      </Index>
      <button type="button" class="btn-ghost" onClick={addAttribute}>
        + Add attribute
      </button>
    </div>
  );
};

interface DefaultValueInputProps {
  type: AttributeType;
  value: unknown;
  options?: string[];
  onChange: (value: unknown) => void;
}

const DefaultValueInput: Component<DefaultValueInputProps> = (props) => {
  return (
    <Switch fallback={
      <input
        placeholder="empty"
        title="Default value for new items"
        value={props.value != null ? String(props.value) : ""}
        onBlur={(e) => props.onChange(e.currentTarget.value || undefined)}
        style="max-width: 80px"
      />
    }>
      <Match when={props.type === "url"}>
        <input
          placeholder="https://..."
          title="Default value for new items"
          value={props.value != null ? String(props.value) : ""}
          onBlur={(e) => props.onChange(e.currentTarget.value || undefined)}
          style="max-width: 80px"
        />
      </Match>
      <Match when={props.type === "number"}>
        <input
          type="number"
          placeholder="(none)"
          title="Default value for new items"
          value={props.value != null ? Number(props.value) : ""}
          onBlur={(e) => {
            const v = e.currentTarget.valueAsNumber;
            props.onChange(isNaN(v) ? undefined : v);
          }}
          style="max-width: 80px"
        />
      </Match>
      <Match when={props.type === "rating"}>
        <input
          type="number"
          placeholder="(none)"
          title="Default value for new items"
          value={props.value != null ? Number(props.value) : ""}
          min="0"
          max="10"
          onBlur={(e) => {
            const v = e.currentTarget.valueAsNumber;
            props.onChange(isNaN(v) ? undefined : v);
          }}
          style="max-width: 80px"
        />
      </Match>
      <Match when={props.type === "boolean"}>
        <select
          title="Default value for new items"
          value={props.value === true ? "true" : "false"}
          onChange={(e) => props.onChange(e.currentTarget.value === "true")}
          style="max-width: 80px"
        >
          <option value="false">No</option>
          <option value="true">Yes</option>
        </select>
      </Match>
      <Match when={props.type === "enum"}>
        <select
          title="Default value for new items"
          value={props.value != null ? String(props.value) : ""}
          onChange={(e) => props.onChange(e.currentTarget.value || undefined)}
          style="max-width: 100px"
        >
          <option value="">(none)</option>
          <For each={props.options ?? []}>
            {(opt) => <option value={opt}>{opt}</option>}
          </For>
        </select>
      </Match>
      <Match when={props.type === "date" || props.type === "datetime"}>
        <input
          type={props.type === "datetime" ? "datetime-local" : "date"}
          title="Default value for new items"
          value={props.value != null ? String(props.value) : ""}
          onChange={(e) => props.onChange(e.currentTarget.value || undefined)}
          style="max-width: 100px"
        />
      </Match>
      <Match when={props.type === "duration"}>
        <input
          type="number"
          placeholder="(none)"
          title="Default value for new items (in minutes)"
          value={props.value != null ? Number(props.value) : ""}
          min="0"
          onBlur={(e) => {
            const v = e.currentTarget.valueAsNumber;
            props.onChange(isNaN(v) ? undefined : v);
          }}
          style="max-width: 80px"
        />
      </Match>
    </Switch>
  );
};

export default SchemaEditor;
