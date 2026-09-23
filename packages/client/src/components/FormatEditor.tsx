import { type Component, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { compileFormat, escapeFormatText, formatDiagnostic, isSet, type AttributeDefinition, type Item } from "@listr/shared";
import FormattedText from "./FormattedText.js";
import { createAsset } from "../db/assets.js";
import { assetUrls } from "../sync/assetStore.js";

interface Props {
  id: string;
  value: string;
  onInput: (text: string) => void;
  schema: AttributeDefinition[];
  /** Board format that this list format inherits from. */
  base?: string;
  /** Items to choose a live preview from, best first (see rankSampleItems). */
  sampleItems?: Item[];
  placeholder?: string;
}

/** Append a definition line, adding the blank line that starts the definitions section if needed. */
export function appendDefinition(text: string, line: string): string {
  const trimmed = text.trimEnd();
  const lines = trimmed.split("\n");
  const hasDefinitions = lines.slice(1).some((l) => l.trim() === "");
  return `${trimmed}${hasDefinitions ? "\n" : "\n\n"}${line}`;
}

/** Order items for the preview: those with the most attributes set come first. */
export function rankSampleItems(items: Item[]): Item[] {
  const setCount = (item: Item) => Object.values(item.attributes).filter(isSet).length;
  return items
    .map((item) => ({ item, n: setCount(item) }))
    .sort((a, b) => b.n - a.n || a.item.title.localeCompare(b.item.title))
    .map(({ item }) => item);
}

/** Whether `text` has errors that should block saving. */
export function formatHasErrors(text: string, schema: AttributeDefinition[], base?: string): boolean {
  return compileFormat(text, schema, base).hasErrors;
}

const FormatEditor: Component<Props> = (props) => {
  // The text that diagnostics and the preview reflect. Typing updates it after
  // a pause; a value set from outside (eg reopening the form) applies at once.
  const [checked, setChecked] = createSignal(props.value);
  let typed: string | undefined;
  const [draggingOver, setDraggingOver] = createSignal(false);
  const [assetUploading, setAssetUploading] = createSignal(false);
  const [assetError, setAssetError] = createSignal<string | null>(null);
  let fileInputRef!: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(debounceTimer));

  // Keep the browser from navigating to a URL dropped anywhere on the page.
  onMount(() => {
    const block = (e: DragEvent) => e.preventDefault();
    document.addEventListener("dragover", block);
    document.addEventListener("drop", block);
    onCleanup(() => {
      document.removeEventListener("dragover", block);
      document.removeEventListener("drop", block);
    });
  });

  const compiled = createMemo(() => compileFormat(checked(), props.schema, props.base));
  const rows = () => Math.min(16, Math.max(2, props.value.split("\n").length + 1));

  createEffect(on(() => props.value, (value) => {
    clearTimeout(debounceTimer);
    if (value === typed) {
      debounceTimer = setTimeout(() => setChecked(value), 300);
    } else {
      setChecked(value);
    }
  }));

  const handleInput = (value: string) => {
    typed = value;
    props.onInput(value);
  };

  const insertAsset = (asset: { id: string; ext: string; filename: string }) => {
    const alt = asset.filename.includes(".") ? asset.filename.slice(0, asset.filename.lastIndexOf(".")) : asset.filename;
    const line = `img${asset.id.slice(0, 6)}="![${escapeFormatText(alt)}](hash://${asset.id}.${asset.ext})"`;
    handleInput(appendDefinition(props.value, line));
  };

  const handleAssetFiles = async (files: Iterable<File> | null) => {
    if (!files) return;
    setAssetUploading(true);
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) insertAsset(await createAsset(file));
      }
    } finally {
      setAssetUploading(false);
    }
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
      insertAsset(await createAsset(new File([blob], filename, { type: blob.type })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAssetError(`Could not fetch image (${msg}). The site may block cross-origin requests. Try right-clicking the image, choosing "Copy Image", and pasting here instead.`);
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
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDraggingOver(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingOver(false);
    if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) {
      await handleAssetFiles(e.dataTransfer.files);
      return;
    }
    // Firefox uses text/x-moz-url; others use text/uri-list.
    const rawUrl =
      e.dataTransfer?.getData("text/x-moz-url")?.split("\n")[0] ||
      e.dataTransfer?.getData("text/uri-list")?.split("\n").find((l) => !l.startsWith("#")) ||
      e.dataTransfer?.getData("text/plain");
    if (rawUrl && /^https?:\/\//.test(rawUrl)) await handleUrlAsset(rawUrl);
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      await handleAssetFiles(files);
    }
  };

  const [sampleId, setSampleId] = createSignal<string | undefined>();
  const sampleItem = () => {
    const items = props.sampleItems ?? [];
    return items.find((i) => i.id === sampleId()) ?? items[0];
  };

  const preview = createMemo(() => {
    const item = sampleItem();
    if (!item) return undefined;
    const urls = assetUrls();
    return compiled().render(item, { urlResolver: (url) => urls[url] ?? url });
  });

  return (
    <>
      <div
        class="format-dropzone"
        classList={{ dragging: draggingOver() }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <textarea
          id={props.id}
          class="format-textarea textarea-code"
          classList={{ "input-error": compiled().hasErrors }}
          value={props.value}
          onInput={(e) => handleInput(e.currentTarget.value)}
          onPaste={handlePaste}
          placeholder={props.placeholder}
          rows={rows()}
          spellcheck={false}
          aria-invalid={compiled().hasErrors}
          aria-describedby={`${props.id}-hint`}
        />
      </div>
      <Show when={compiled().diagnostics.length > 0}>
        <ul class="format-diagnostics" aria-live="polite">
          <For each={compiled().diagnostics}>
            {(d) => <li class={d.severity}>{formatDiagnostic(d)}</li>}
          </For>
        </ul>
      </Show>
      <div class="control-row format-toolbar">
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
          hidden
          onChange={(e) => { handleAssetFiles(e.currentTarget.files); e.currentTarget.value = ""; }}
        />
      </div>
      <Show when={assetError()}>
        {(err) => <div class="field-error">{err()}</div>}
      </Show>
      <div class="field-hint" id={`${props.id}-hint`}>
        Line 1 is the display format. Available: [title]
        {props.schema.length > 0 ? ", " + props.schema.map((a) => `[${a.key}]`).join(", ") : ""}.
        After a blank line, <code>name="..."</code> defines a derived attribute. Drop, paste, or upload
        images to insert them as assets. See doc/FORMAT.md for the full language.
      </div>
      <Show when={preview()}>
        {(p) => (
          <>
            <div class="control-row format-sample">
              <label for={`${props.id}-sample`}>Sample</label>
              <select
                id={`${props.id}-sample`}
                value={sampleItem()?.id}
                onChange={(e) => setSampleId(e.currentTarget.value)}
              >
                <For each={props.sampleItems}>
                  {(item) => <option value={item.id}>{item.title}</option>}
                </For>
              </select>
            </div>
            <div class="format-preview">
              <FormattedText html={p().html} tooltip={p().tooltip} />
            </div>
          </>
        )}
      </Show>
    </>
  );
};

export default FormatEditor;
