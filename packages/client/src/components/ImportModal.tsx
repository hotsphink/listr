import { type Component, createSignal, Show, For, createMemo, onMount, onCleanup } from "solid-js";
import type { AttributeDefinition } from "@listr/shared";
import { db } from "../db/database.js";
import { createCategory, createList, bulkCreateItems } from "../db/operations.js";
import Modal from "./Modal.js";

export type ImportScope =
  | { type: "global" }
  | { type: "category"; id: string; name: string; schema: AttributeDefinition[]; format_string: string; macros: Record<string, string> }
  | { type: "list"; id: string; name: string; schema: AttributeDefinition[]; format_string: string; macros: Record<string, string> };

interface ImportedItem { title: string; attributes: Record<string, unknown>; }
interface ImportedList { name: string; items: ImportedItem[]; }
interface ImportedCategory { name: string; lists: ImportedList[]; }

interface PreviewItem extends ImportedItem { skip: boolean; }
interface PreviewList { name: string; existingId?: string; items: PreviewItem[]; newCount: number; }
interface PreviewCategory { name: string; existingId?: string; lists: PreviewList[]; }

interface Props {
  open: boolean;
  onClose: () => void;
  scope: ImportScope;
}

async function getApiUrl(): Promise<string | null> {
  const cfg = await db.sync_config.get("default");
  if (!cfg?.sync_url) return null;
  return cfg.sync_url.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

async function fetchExtraction(imageBase64: string, mimeType: string, scope: ImportScope): Promise<ImportedCategory[]> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) throw new Error("No sync server configured. Set up a sync server first — the AI key lives there.");

  const resp = await fetch(`${apiUrl}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: imageBase64,
      mime_type: mimeType,
      scope: scope.type === "category" || scope.type === "list"
        ? { type: scope.type, name: scope.name, schema: scope.schema }
        : { type: "global" },
    }),
  });

  const data = await resp.json() as any;
  if (!resp.ok) throw new Error(data.error ?? `Server error ${resp.status}`);
  return (data.categories ?? []) as ImportedCategory[];
}

async function buildPreview(extracted: ImportedCategory[], scope: ImportScope): Promise<PreviewCategory[]> {
  console.log("[import] buildPreview: querying DB...");
  const [allCats, allLists, allItems] = await Promise.all([
    db.categories.toArray(),
    db.lists.toArray(),
    db.items.toArray(),
  ]);
  console.log("[import] buildPreview: DB query done", allCats.length, "cats", allLists.length, "lists", allItems.length, "items");

  if (scope.type === "list") {
    const existingTitles = new Set(
      allItems.filter((i) => i.list_id === scope.id).map((i) => i.title.toLowerCase()),
    );
    const allExtracted = extracted.flatMap((cat) => cat.lists.flatMap((l) => l.items));
    const items: PreviewItem[] = allExtracted.map((item) => ({
      ...item,
      attributes: item.attributes ?? {},
      skip: existingTitles.has(item.title.toLowerCase()),
    }));
    return [{
      name: scope.name,
      existingId: scope.id,
      lists: [{ name: scope.name, existingId: scope.id, items, newCount: items.filter((i) => !i.skip).length }],
    }];
  }

  return extracted.map((cat) => {
    const existingCat = allCats.find((c) => c.name.toLowerCase() === cat.name.toLowerCase());
    const catListIds = new Set(allLists.filter((l) => l.category_id === existingCat?.id).map((l) => l.id));
    const catLists = allLists.filter((l) => l.category_id === existingCat?.id);

    const lists = cat.lists.map((list) => {
      const existingList = catLists.find((l) => l.name.toLowerCase() === list.name.toLowerCase());
      const existingTitles = new Set(
        allItems.filter((i) => i.list_id === existingList?.id).map((i) => i.title.toLowerCase())
      );
      const items: PreviewItem[] = list.items.map((item) => ({
        ...item,
        attributes: item.attributes ?? {},
        skip: !!existingList && existingTitles.has(item.title.toLowerCase()),
      }));
      return {
        name: list.name,
        existingId: existingList?.id,
        items,
        newCount: items.filter((i) => !i.skip).length,
      };
    });

    return { name: cat.name, existingId: existingCat?.id, lists };
  });
}

async function performImport(preview: PreviewCategory[], scope: ImportScope): Promise<number> {
  if (scope.type === "list") {
    const newItems = preview.flatMap((c) => c.lists.flatMap((l) => l.items.filter((i) => !i.skip)));
    if (newItems.length > 0) await bulkCreateItems(scope.id, newItems);
    return newItems.length;
  }

  let total = 0;
  for (const cat of preview) {
    let catId = cat.existingId;
    if (!catId) {
      const schema = scope.type === "category" ? scope.schema : [];
      const fmt = scope.type === "category" ? scope.format_string : "{title}";
      const macros = scope.type === "category" ? scope.macros : {};
      const newCat = await createCategory(cat.name, "#5b8def", schema, fmt, macros);
      catId = newCat.id;
    }
    for (const list of cat.lists) {
      let listId = list.existingId;
      if (!listId) {
        const newList = await createList(list.name, catId);
        listId = newList.id;
      }
      const newItems = list.items.filter((i) => !i.skip);
      if (newItems.length > 0) {
        await bulkCreateItems(listId, newItems);
        total += newItems.length;
      }
    }
  }
  return total;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]); // strip data URL prefix
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

const ImportModal: Component<Props> = (props) => {
  type Phase = "idle" | "extracting" | "preview" | "importing" | "done";
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewCategory[]>([]);
  const [importedCount, setImportedCount] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);

  let fileInputRef!: HTMLInputElement;

  // Capture paste anywhere while modal is open and idle
  onMount(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (phase() !== "idle") return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) { e.preventDefault(); processFile(file); }
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));
  });

  const totalNew = createMemo(() => preview().flatMap((c) => c.lists).reduce((s, l) => s + l.newCount, 0));
  const totalSkip = createMemo(() => preview().flatMap((c) => c.lists.flatMap((l) => l.items)).filter((i) => i.skip).length);

  const reset = () => { setPhase("idle"); setError(null); setPreview([]); };

  const handleClose = () => { reset(); props.onClose(); };

  const processFile = async (file: File) => {
    if (!file.type.startsWith("image/")) { setError("Please select an image file."); return; }
    setError(null);
    setPhase("extracting");
    try {
      console.log("[import] fileToBase64 start");
      const base64 = await fileToBase64(file);
      console.log("[import] fetchExtraction start");
      const extracted = await fetchExtraction(base64, file.type, props.scope);
      console.log("[import] fetchExtraction done, categories:", extracted.length);
      const prev = await buildPreview(extracted, props.scope);
      console.log("[import] buildPreview done, preview categories:", prev.length);
      setPreview(prev);
      setPhase("preview");
      console.log("[import] phase set to preview");
    } catch (e) {
      console.error("[import] error:", e);
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const handleConfirm = async () => {
    setPhase("importing");
    try {
      const count = await performImport(preview(), props.scope);
      setImportedCount(count);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("preview");
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) await processFile(file);
  };

  const handlePaste = async (e: ClipboardEvent) => {
    const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); await processFile(file); }
  };

  const scopeLabel = () =>
    props.scope.type === "category" || props.scope.type === "list"
      ? `into "${props.scope.name}"`
      : "globally";

  return (
    <Modal open={props.open} onClose={handleClose}>
      <h2>Import from Screenshot</h2>

      <Show when={phase() === "idle" || phase() === "extracting"}>
        <p class="field-hint" style="margin-bottom: 12px">
          Upload a Trello board screenshot to import {scopeLabel()}.
        </p>
        <div
          class="import-dropzone"
          classList={{ dragging: dragging(), loading: phase() === "extracting" }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={handleDrop}
          onClick={() => phase() === "idle" && fileInputRef.click()}
        >
          <Show when={phase() === "extracting"} fallback={
            <div class="import-dropzone-hint">
              <div style="font-size: 2em; margin-bottom: 8px">📷</div>
              <div>Drop or paste screenshot, or click to select</div>
              <div class="field-hint" style="margin-top: 4px">PNG, JPG, WebP &mdash; Ctrl+V works too</div>
            </div>
          }>
            <div class="import-dropzone-hint">
              <div style="font-size: 1.5em; margin-bottom: 8px">⏳</div>
              <div>Extracting with Gemini...</div>
            </div>
          </Show>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*" style="display:none"
          onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processFile(f); e.currentTarget.value = ""; }} />
        <Show when={error()}>
          {(err) => <div class="field-error" style="margin-top: 8px">{err()}</div>}
        </Show>
        <div class="modal-actions">
          <button class="btn-ghost" onClick={handleClose}>Cancel</button>
        </div>
      </Show>

      <Show when={phase() === "preview" || phase() === "importing"}>
        <div class="import-summary">
          <strong>{totalNew()}</strong> new item{totalNew() !== 1 ? "s" : ""} to add
          <Show when={totalSkip() > 0}>
            {" "}&mdash; <span class="text-muted">{totalSkip()} already exist, will be skipped</span>
          </Show>
        </div>
        <div class="import-preview">
          <For each={preview()}>
            {(cat) => (
              <>
                <Show when={props.scope.type !== "list"}>
                  <div class="import-preview-category">
                    {cat.name}
                    <Show when={!cat.existingId}>
                      {" "}<span class="badge badge-new">new category</span>
                    </Show>
                  </div>
                </Show>
                <For each={cat.lists}>
                  {(list) => (
                    <>
                      <div class="import-preview-list">
                        {list.name}
                        <Show when={!list.existingId}>
                          {" "}<span class="badge badge-new">new list</span>
                        </Show>
                        {" "}
                        <span class="text-muted">({list.newCount} new{list.items.length - list.newCount > 0 ? `, ${list.items.length - list.newCount} skip` : ""})</span>
                      </div>
                      <For each={list.items}>
                        {(item) => (
                          <div class="import-preview-item" classList={{ skip: item.skip }}>
                            <span class={item.skip ? "badge badge-skip" : "badge badge-new"}>
                              {item.skip ? "skip" : "new"}
                            </span>
                            <span class="import-item-title">{item.title}</span>
                            <For each={Object.entries(item.attributes).filter(([, v]) => v != null && v !== "")}>
                              {([k, v]) => (
                                <span class="import-attr-pill">{k}: {String(v)}</span>
                              )}
                            </For>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </>
            )}
          </For>
        </div>
        <Show when={error()}>
          {(err) => <div class="field-error" style="margin-top: 8px">{err()}</div>}
        </Show>
        <div class="modal-actions">
          <button class="btn-ghost" onClick={() => { setError(null); setPhase("idle"); }} disabled={phase() === "importing"}>Back</button>
          <button class="btn-primary" onClick={handleConfirm} disabled={phase() === "importing" || totalNew() === 0}>
            {phase() === "importing" ? "Importing..." : `Import ${totalNew()} item${totalNew() !== 1 ? "s" : ""}`}
          </button>
        </div>
      </Show>

      <Show when={phase() === "done"}>
        <div style="text-align: center; padding: 24px 0">
          <div style="font-size: 2em; margin-bottom: 8px">✓</div>
          <div>Imported {importedCount()} item{importedCount() !== 1 ? "s" : ""} successfully.</div>
        </div>
        <div class="modal-actions">
          <button class="btn-primary" onClick={handleClose}>Done</button>
        </div>
      </Show>
    </Modal>
  );
};

export default ImportModal;
