import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import type { AttributeDefinition, Board } from "@listr/shared";
import { validateFormatString, parseAdvancedFormatText, serializeAdvancedFormatText } from "@listr/shared";
import Modal from "./Modal.js";
import SchemaEditor from "./SchemaEditor.js";
import { createAsset } from "../db/assets.js";

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
  }) => Promise<void> | void;
  initial?: Board;
}

const BoardFormModal: Component<Props> = (props) => {
  const [name, setName] = createSignal("");
  const [color, setColor] = createSignal("#5b8def");
  const [formatStr, setFormatStr] = createSignal("{title}");
  const [macros, setMacros] = createSignal<Record<string, string>>({});
  const [schema, setSchema] = createSignal<AttributeDefinition[]>([]);
  const [formatManuallyEdited, setFormatManuallyEdited] = createSignal(false);
  const [nameError, setNameError] = createSignal<string | null>(null);
  const [formatError, setFormatError] = createSignal<string | null>(null);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [advancedMode, setAdvancedMode] = createSignal(false);
  const [advancedText, setAdvancedText] = createSignal("");
  const [advancedError, setAdvancedError] = createSignal<string | null>(null);
  const [draggingOver, setDraggingOver] = createSignal(false);
  const [assetUploading, setAssetUploading] = createSignal(false);
  const [assetError, setAssetError] = createSignal<string | null>(null);

  let fileInputRef!: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (debounceTimer) clearTimeout(debounceTimer); });

  // Prevent browser from navigating to dropped URLs when in advanced mode
  createEffect(() => {
    if (!advancedMode()) return;
    const block = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    onCleanup(() => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    });
  });

  createEffect(() => {
    if (props.open) {
      setName(props.initial?.name ?? "");
      setColor(props.initial?.color ?? "#5b8def");
      setFormatStr(props.initial?.format_string ?? "{title}");
      setMacros(props.initial?.macros ?? {});
      setSchema(props.initial?.schema ?? []);
      setFormatManuallyEdited(!!props.initial);
      setNameError(null);
      setFormatError(null);
      setSaveError(null);
      setSaving(false);
      setAdvancedMode(false);
      setAdvancedError(null);
      setAssetError(null);
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

  const appendAssetMacro = (asset: { id: string; ext: string; filename: string }) => {
    const prefix = "img" + asset.id.slice(0, 6);
    const nameWithoutExt = asset.filename.includes(".") ? asset.filename.slice(0, asset.filename.lastIndexOf(".")) : asset.filename;
    const macro = `${prefix}=![${nameWithoutExt}](hash://${asset.id}.${asset.ext})`;
    const current = advancedText();
    handleAdvancedInput(current ? `${current}\n${macro}` : macro);
  };

  const processImageFiles = async (files: Iterable<File>) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (!advancedMode()) openAdvanced();
      const asset = await createAsset(file);
      appendAssetMacro(asset);
    }
  };

  const handleAssetFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setAssetUploading(true);
    try { await processImageFiles(files); }
    finally { setAssetUploading(false); }
  };

  const handleUrlAsset = async (url: string) => {
    setAssetUploading(true);
    setAssetError(null);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (!blob.type.startsWith("image/")) return;
      const filename = url.split("/").pop()?.split("?")[0] || "image";
      const file = new File([blob], filename, { type: blob.type });
      if (!advancedMode()) openAdvanced();
      const asset = await createAsset(file);
      appendAssetMacro(asset);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAssetError(`Could not fetch image (${msg}). The site may block cross-origin requests — try right-clicking the image, choosing "Copy Image", and pasting here instead.`);
    } finally {
      setAssetUploading(false);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    setDraggingOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    const dropzone = e.currentTarget as HTMLElement;
    if (!dropzone.contains(e.relatedTarget as Node)) {
      setDraggingOver(false);
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);

    // Local file drag (from filesystem)
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      await handleAssetFiles(e.dataTransfer.files);
      return;
    }

    // URL drag from browser — Firefox uses text/x-moz-url, others use text/uri-list
    const rawUrl =
      e.dataTransfer?.getData("text/x-moz-url")?.split("\n")[0] ??
      e.dataTransfer?.getData("text/uri-list")?.split("\n").find((l) => !l.startsWith("#")) ??
      e.dataTransfer?.getData("text/plain");
    if (rawUrl && /^https?:\/\//.test(rawUrl)) {
      await handleUrlAsset(rawUrl);
    }
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      await handleAssetFiles(files);
    }
  };

  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setSaveError(null);

    const nameValue = name().trim();
    if (!nameValue) {
      setNameError("Name is required");
      return;
    }
    setNameError(null);

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

    setSaving(true);
    try {
      await props.onSave({
        name: nameValue,
        color: color(),
        format_string: currentFormat,
        schema: schema(),
        macros: currentMacros,
      });
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed. Check that your browser allows storage.");
    } finally {
      setSaving(false);
    }
  };

  const macroKeys = () => Object.keys(macros());

  return (
    <Modal open={props.open} onClose={props.onClose} class="board-form">
      <div class="modal-page-header">
        <button class="modal-page-back" type="button" onClick={props.onClose} aria-label="Back">←</button>
      </div>
      <h2>{props.initial ? "Edit Board" : "New Board"}</h2>
      <form onSubmit={handleSubmit}>
        <div class="form-row">
          <div class="form-field" style="flex: 1">
            <label>Name</label>
            <input
              classList={{ "input-error": nameError() !== null }}
              value={name()}
              onInput={(e) => { setName(e.currentTarget.value); setNameError(null); }}
              autofocus
            />
            <Show when={nameError()}>
              {(err) => <div class="field-error">{err()}</div>}
            </Show>
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
            <div
              class="format-advanced-dropzone"
              classList={{ dragging: draggingOver() }}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <textarea
                class="format-advanced-textarea"
                classList={{ "input-error": advancedError() !== null }}
                value={advancedText()}
                onInput={(e) => handleAdvancedInput(e.currentTarget.value)}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onPaste={handlePaste}
                rows={6}
                spellcheck={false}
              />
            </div>
            <div class="format-advanced-toolbar">
              <button
                type="button"
                class="btn-ghost btn-xs"
                disabled={assetUploading()}
                onClick={() => fileInputRef.click()}
              >
                {assetUploading() ? "Uploading..." : "Insert image asset"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                style="display: none"
                onChange={(e) => { handleAssetFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
              />
            </div>
            <Show when={assetError()}>
              {(err) => <div class="field-error">{err()}</div>}
            </Show>
            <Show when={advancedError()}>
              {(err) => <div class="field-error">{err()}</div>}
            </Show>
            <div class="field-hint">
              Line 1: format string. Lines 2+: <code>name=format</code> to define macros. Use <code>{"{name}"}</code> to reference them. Drop, paste, or upload images to insert as assets.
            </div>
          </Show>
        </div>
        <div class="form-field">
          <label>Attributes</label>
          <SchemaEditor schema={schema()} onChange={handleSchemaChange} />
        </div>
        <Show when={saveError()}>
          {(err) => <div class="field-error" style="margin-bottom: 8px">{err()}</div>}
        </Show>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" onClick={props.onClose} disabled={saving()}>
            Cancel
          </button>
          <button type="submit" class="btn-primary" disabled={saving()}>
            {saving() ? "Saving..." : props.initial ? "Save" : "Create"}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default BoardFormModal;
