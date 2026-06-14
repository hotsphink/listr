import { type Component, For, Index } from "solid-js";
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
              value={attr().key}
              onBlur={(e) => updateAt(i, { key: e.currentTarget.value })}
              style="max-width: 100px"
            />
            <input
              placeholder="Label"
              value={attr().label}
              onBlur={(e) => updateAt(i, { label: e.currentTarget.value })}
            />
            <select
              value={attr().type}
              onChange={(e) => updateAt(i, { type: e.currentTarget.value as AttributeType })}
              style="max-width: 110px"
            >
              <For each={ATTRIBUTE_TYPES}>
                {(t) => <option value={t.value}>{t.label}</option>}
              </For>
            </select>
            {(attr().type === "enum" || attr().type === "tags") && (
              <input
                placeholder="opt1, opt2, ..."
                value={(attr().options ?? []).join(", ")}
                onBlur={(e) =>
                  updateAt(i, {
                    options: e.currentTarget.value.split(",").map((s) => s.trim()).filter(Boolean),
                  })
                }
                style="max-width: 160px"
              />
            )}
            <button type="button" class="btn-icon" onClick={() => removeAt(i)} title="Remove">
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

export default SchemaEditor;
