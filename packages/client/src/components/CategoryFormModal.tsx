import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import type { AttributeDefinition, Category } from "@listr/shared";
import { validateFormatString, parseAdvancedFormatText, serializeAdvancedFormatText } from "@listr/shared";
import Modal from "./Modal.js";
import SchemaEditor from "./SchemaEditor.js";

function generateFormatString(schema: AttributeDefinition[]): string {
  if (schema.length === 0) return "{title}";
  const parts = schema.map((a) => `{${a.key}}`);
  return `{title} (${parts.join(", ")})`;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    color: string;
    format_string: string;
    schema: AttributeDefinition[];
    macros: Record<string, string>;
  }) => void;
  initial?: Category;
}

const CategoryFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal("#5b8def");
  const [formatStr, setFormatStr] = createSignal("{title}");
  const [macros, setMacros] = createSignal<Record<string, string>>({});
  const [schema, setSchema] = createSignal<AttributeDefinition[]>([]);
  const [formatManuallyEdited, setFormatManuallyEdited] = createSignal(false);
  const [formatError, setFormatError] = createSignal<string | null>(null);
  const [advancedMode, setAdvancedMode] = createSignal(false);
  const [advancedText, setAdvancedText] = createSignal("");
  const [advancedError, setAdvancedError] = createSignal<string | null>(null);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (debounceTimer) clearTimeout(debounceTimer); });

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setColor(props.initial?.color ?? "#5b8def");
      setFormatStr(props.initial?.format_string ?? "{title}");
      setMacros(props.initial?.macros ?? {});
      setSchema(props.initial?.schema ?? []);
      setFormatManuallyEdited(!!props.initial);
      setFormatError(null);
      setAdvancedMode(false);
      setAdvancedError(null);
    }
  });

  const handleSchemaChange = (newSchema: AttributeDefinition[]) => {
    setSchema(newSchema);
    if (!formatManuallyEdited()) {
      setFormatStr(generateFormatString(newSchema));
    }
  };

  const handleFormatInput = (value: string) => {
    setFormatStr(value);
    setFormatManuallyEdited(true);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      setFormatError(validateFormatString(value, macros()));
    }, 300);
  };

  const handleAdvancedInput = (value: string) => {
    setAdvancedText(value);
    setAdvancedError(parseAdvancedFormatText(value).error);
  };

  const openAdvanced = () => {
    setAdvancedText(serializeAdvancedFormatText(formatStr(), macros()));
    setAdvancedError(null);
    setAdvancedMode(true);
  };

  const applyAdvanced = (): { format: string; macros: Record<string, string> } | null => {
    const { format, macros: newMacros, error } = parseAdvancedFormatText(advancedText());
    if (error) { setAdvancedError(error); return null; }
    setFormatStr(format);
    setMacros(newMacros);
    setFormatManuallyEdited(true);
    setFormatError(null);
    setAdvancedMode(false);
    return { format, macros: newMacros };
  };

  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (!name().trim()) return;

    let currentFormat = formatStr();
    let currentMacros = macros();

    if (advancedMode()) {
      const applied = applyAdvanced();
      if (!applied) return;
      currentFormat = applied.format;
      currentMacros = applied.macros;
    }

    const err = validateFormatString(currentFormat, currentMacros);
    if (err) { setFormatError(err); return; }

    props.onSave({
      name: name().trim(),
      color: color(),
      format_string: currentFormat,
      schema: schema(),
      macros: currentMacros,
    });
  };

  const macroKeys = () => Object.keys(macros());

  return (
    <Modal open={props.open} onClose={props.onClose}>
      <h2>{props.initial ? "Edit Category" : "New Category"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-row">
          <div class="form-field" style="flex: 1">
            <label>Name</label>
            <input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              autofocus
            />
          </div>
          <div class="form-field" style="flex: 0; min-width: 60px">
            <label>Color</label>
            <input
              type="color"
              value={color()}
              onInput={(e) => setColor(e.currentTarget.value)}
              style="height: 32px; padding: 2px"
            />
          </div>
        </div>
        <div class="form-field">
          <div class="format-field-header">
            <label>Format String</label>
            <button
              type="button"
              class="btn-ghost btn-xs"
              onClick={advancedMode() ? () => applyAdvanced() : openAdvanced}
            >
              {advancedMode() ? "Basic" : "Advanced"}
            </button>
          </div>
          <Show
            when={advancedMode()}
            fallback={
              <>
                <input
                  classList={{ "input-error": formatError() !== null }}
                  value={formatStr()}
                  onInput={(e) => handleFormatInput(e.currentTarget.value)}
                  placeholder="{title}"
                />
                <Show when={formatError()}>
                  {(err) => <div class="field-error">{err()}</div>}
                </Show>
                <div class="field-hint">
                  Available: {"{title}"}
                  {schema().length > 0 ? ", " + schema().map((a) => `{${a.key}}`).join(", ") : ""}
                  {macroKeys().length > 0 ? ", " + macroKeys().map((k) => `{${k}} (macro)`).join(", ") : ""}
                </div>
              </>
            }
          >
            <textarea
              class="format-advanced-textarea"
              classList={{ "input-error": advancedError() !== null }}
              value={advancedText()}
              onInput={(e) => handleAdvancedInput(e.currentTarget.value)}
              rows={6}
              spellcheck={false}
            />
            <Show when={advancedError()}>
              {(err) => <div class="field-error">{err()}</div>}
            </Show>
            <div class="field-hint">
              Line 1: format string. Lines 2+: <code>name=format</code> to define macros. Use <code>{"{name}"}</code> to reference them.
            </div>
          </Show>
        </div>
        <div class="form-field">
          <label>Attributes</label>
          <SchemaEditor schema={schema()} onChange={handleSchemaChange} />
        </div>
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

export default CategoryFormModal;
