import { type Component, createSignal, Show, For, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import { db, type ImportScope, type PendingImport } from "../db/database.js";
import { createBoard, createList, bulkCreateItems } from "../db/operations.js";
import { syncClient } from "../sync/SyncClient.js";
import { isNativeExport, previewNativeImport, applyNativeImport, computeAiImportOrder, DEFAULT_IMPORT_OPTIONS, type ImportOptions } from "../db/exportImport.js";
import type { NativeExport, ImportStats } from "../db/exportImport.js";
import Modal from "./Modal.js";

export type { ImportScope };

interface ImportedItem { title: string; attributes: Record<string, unknown>; }
interface ImportedList { name: string; items: ImportedItem[]; }
interface ImportedBoard { name: string; lists: ImportedList[]; }

interface PreviewItem extends ImportedItem { skip: boolean; keep: boolean; }
interface PreviewList { name: string; existingId?: string; items: PreviewItem[]; }
interface PreviewBoard { name: string; existingId?: string; lists: PreviewList[]; }

interface Props {
  open: boolean;
  onClose: () => void;
  scope: ImportScope;
}

async function getApiUrl(): Promise<string | null> {
  const endpoints = await db.sync_endpoints.orderBy("position").toArray();
  const ep = endpoints.find((e) => e.enabled);
  if (!ep?.host) return null;
  const proto = ep.secure ? "https" : "http";
  return `${proto}://${ep.host}:${ep.port}`;
}

async function fetchExtraction(imageBase64: string, mimeType: string, scope: ImportScope): Promise<{ boards: ImportedBoard[]; raw: string }> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) throw new Error("No sync server configured. Set up a sync server first, since the AI key lives there.");

  const resp = await fetch(`${apiUrl}/api/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: imageBase64,
      mime_type: mimeType,
      scope: scope.type === "board" || scope.type === "list"
        ? { type: scope.type, name: scope.name, schema: scope.schema }
        : { type: "global" },
    }),
  });

  const raw = await resp.text();
  (window as any).lastImportRawResult = raw;
  console.log("Import response received; inspect with: window.lastImportRawResult");
  if (!resp.ok) {
    let msg = `Server error ${resp.status}`;
    try { msg = (JSON.parse(raw) as any).error ?? msg; } catch {}
    throw new Error(msg);
  }
  const data = JSON.parse(raw) as any;
  return { boards: normalizeExtraction(data, scope), raw };
}

// AI returns attributes as top-level fields alongside title; move them into attributes.
function normalizeItem(raw: any): ImportedItem {
  const { title, ...attrs } = raw;
  return { title: String(title ?? ""), attributes: attrs };
}

function normalizeExtraction(data: any, scope: ImportScope): ImportedBoard[] {
  if (Array.isArray(data.items)) {
    // List scope: {"items": [...]}
    const name = scope.type === "list" ? scope.name : "Items";
    const items = data.items.map(normalizeItem);
    return [{ name, lists: [{ name, items }] }];
  }
  if (Array.isArray(data.lists)) {
    // Board/global scope: {"lists": [{name, items}, ...]}
    const boardName = scope.type === "board" ? scope.name : "Import";
    const lists = data.lists.map((l: any) => ({
      name: l.name,
      items: (l.items ?? []).map(normalizeItem),
    }));
    return [{ name: boardName, lists }];
  }
  return (data.boards ?? []) as ImportedBoard[];
}

// An unchecked item is dropped outright: not created, and not merged into an
// existing item either.
function kept(items: PreviewItem[]): PreviewItem[] {
  return items.filter((i) => i.keep);
}

function newCountOf(items: PreviewItem[]): number {
  return kept(items).filter((i) => !i.skip).length;
}

async function buildPreview(extracted: ImportedBoard[], scope: ImportScope): Promise<PreviewBoard[]> {
  const [allBoards, allLists, allItems] = await Promise.all([
    db.boards.toArray(),
    db.lists.toArray(),
    db.items.toArray(),
  ]);

  if (scope.type === "list") {
    const existingTitles = new Set(
      allItems.filter((i) => i.list_id === scope.id).map((i) => i.title.toLowerCase()),
    );
    const allExtracted = extracted.flatMap((board) => board.lists.flatMap((l) => l.items));
    const items: PreviewItem[] = allExtracted.map((item) => ({
      ...item,
      attributes: item.attributes ?? {},
      skip: existingTitles.has(item.title.toLowerCase()),
      keep: true,
    }));
    return [{
      name: scope.name,
      existingId: scope.id,
      lists: [{ name: scope.name, existingId: scope.id, items }],
    }];
  }

  return extracted.map((board) => {
    const existingBoard = allBoards.find((b) => b.name.toLowerCase() === board.name.toLowerCase());
    const boardLists = allLists.filter((l) => l.board_id === existingBoard?.id);

    const lists = board.lists.map((list) => {
      const existingList = boardLists.find((l) => l.name.toLowerCase() === list.name.toLowerCase());
      const existingTitles = new Set(
        allItems.filter((i) => i.list_id === existingList?.id).map((i) => i.title.toLowerCase())
      );
      const items: PreviewItem[] = list.items.map((item) => ({
        ...item,
        attributes: item.attributes ?? {},
        skip: !!existingList && existingTitles.has(item.title.toLowerCase()),
        keep: true,
      }));
      return {
        name: list.name,
        existingId: existingList?.id,
        items,
      };
    });

    return { name: board.name, existingId: existingBoard?.id, lists };
  });
}

async function applyAttributeMerge(listId: string, allPreviewItems: PreviewItem[]): Promise<void> {
  const skipItems = allPreviewItems.filter((i) => i.skip && Object.keys(i.attributes).length > 0);
  if (skipItems.length === 0) return;
  const existingItems = await db.items.where("list_id").equals(listId).toArray();
  const titleToItem = new Map(existingItems.map((i) => [i.title.toLowerCase(), i]));
  const ts = Date.now();
  for (const preview of skipItems) {
    const existing = titleToItem.get(preview.title.toLowerCase());
    if (!existing) continue;
    const merged: Record<string, unknown> = { ...existing.attributes };
    let changed = false;
    for (const [key, value] of Object.entries(preview.attributes)) {
      const cur = existing.attributes[key];
      if (value != null && value !== "" && (cur == null || cur === "")) {
        merged[key] = value;
        changed = true;
      }
    }
    if (changed) {
      await db.items.update(existing.id, { attributes: merged, updated_at: ts });
      const updated = await db.items.get(existing.id);
      if (updated) syncClient.pushEntity("item", updated);
    }
  }
}

async function applyImportOrder(listId: string, allPreviewItems: PreviewItem[]): Promise<void> {
  const allItems = await db.items.where("list_id").equals(listId).toArray();
  const titleToId = new Map(allItems.map((i) => [i.title.toLowerCase(), i.id]));
  const importedIds = allPreviewItems
    .map((i) => titleToId.get(i.title.toLowerCase()))
    .filter((id): id is string => id !== undefined);
  const updates = computeAiImportOrder(importedIds, allItems);
  if (updates.length > 0) {
    const ts = Date.now();
    await db.transaction("rw", db.items, async () => {
      for (const { id, after_id } of updates) {
        await db.items.update(id, { after_id, updated_at: ts });
      }
    });
  }
}

async function performImport(preview: PreviewBoard[], scope: ImportScope): Promise<number> {
  if (scope.type === "list") {
    const allPreviewItems = kept(preview.flatMap((b) => b.lists.flatMap((l) => l.items)));
    const newItems = allPreviewItems.filter((i) => !i.skip);
    if (newItems.length > 0) await bulkCreateItems(scope.id, newItems);
    await applyAttributeMerge(scope.id, allPreviewItems);
    await applyImportOrder(scope.id, allPreviewItems);
    return newItems.length;
  }

  let total = 0;
  for (const board of preview) {
    let boardId = board.existingId;
    if (!boardId) {
      const schema = scope.type === "board" ? scope.schema : [];
      const format = scope.type === "board" ? scope.format : "[title]";
      const newBoard = await createBoard(board.name, "#5b8def", { schema, format });
      boardId = newBoard.id;
    }
    for (const list of board.lists) {
      let listId = list.existingId;
      if (!listId) {
        const newList = await createList(list.name, boardId);
        listId = newList.id;
      }
      const keptItems = kept(list.items);
      const newItems = keptItems.filter((i) => !i.skip);
      if (newItems.length > 0) {
        await bulkCreateItems(listId, newItems);
        total += newItems.length;
      }
      await applyAttributeMerge(listId, keptItems);
      await applyImportOrder(listId, keptItems);
    }
  }
  return total;
}

function resizeAndEncodeImage(file: File): Promise<{ base64: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const origW = img.naturalWidth;
      const origH = img.naturalHeight;
      console.log(`Image original dimensions: ${origW}x${origH}`);
      const MAX = 3072;
      const scale = Math.max(origW, origH) > MAX ? MAX / Math.max(origW, origH) : 1;
      const newW = Math.round(origW * scale);
      const newH = Math.round(origH * scale);
      console.log(`Image send dimensions: ${newW}x${newH}`);
      const canvas = document.createElement("canvas");
      canvas.width = newW;
      canvas.height = newH;
      canvas.getContext("2d")!.drawImage(img, 0, 0, newW, newH);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
      resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = reject;
    img.src = url;
  });
}

const PENDING_ID = "default";

async function loadPending(): Promise<PendingImport | null> {
  return (await db.pending_import.get(PENDING_ID)) ?? null;
}

// Only one capture may be pending, so this replaces whatever was held before.
async function savePending(image: string, mimeType: string, scope: ImportScope, reason: string): Promise<PendingImport> {
  const row: PendingImport = { id: PENDING_ID, image, mime_type: mimeType, scope, created_at: Date.now(), reason };
  await db.pending_import.put(row);
  return row;
}

async function clearPending(): Promise<void> {
  await db.pending_import.delete(PENDING_ID);
}

function scopeName(scope: ImportScope): string {
  return scope.type === "global" ? "globally" : `into "${scope.name}"`;
}

function whenLabel(ts: number): string {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function statsLabel(stats: ImportStats): string {
  const parts: string[] = [];
  const fmt = (n: { created: number; updated: number; deleted: number }, label: string) => {
    if (n.created + n.updated + n.deleted === 0) return;
    const pieces = [];
    if (n.updated > 0) pieces.push(`${n.updated} updated`);
    if (n.created > 0) pieces.push(`${n.created} new`);
    if (n.deleted > 0) pieces.push(`${n.deleted} deleted`);
    parts.push(`${label}: ${pieces.join(", ")}`);
  };
  fmt(stats.boards, "boards");
  fmt(stats.lists, "lists");
  fmt(stats.items, "items");
  if (stats.assets.created + stats.assets.skipped > 0) {
    parts.push(`assets: ${stats.assets.created} added, ${stats.assets.skipped} already present`);
  }
  return parts.length ? parts.join(" · ") : "nothing to change";
}

const ImportModal: Component<Props> = (props) => {
  type Phase = "idle" | "extracting" | "preview" | "native_preview" | "importing" | "done";
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewBoard[]>([]);
  const [importedCount, setImportedCount] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [rawJson, setRawJson] = createSignal<string | null>(null);
  const [showRaw, setShowRaw] = createSignal(false);
  const [nativeDoc, setNativeDoc] = createSignal<NativeExport | null>(null);
  const [nativeStats, setNativeStats] = createSignal<ImportStats | null>(null);
  const [nativeResult, setNativeResult] = createSignal<ImportStats | null>(null);
  const [importIntegrations, setImportIntegrations] = createSignal<ImportOptions["integrations"]>(DEFAULT_IMPORT_OPTIONS.integrations);

  // Boards in the file that carry integrations, and whether any of those are enabled.
  const nativeBoardsWithIntegrations = createMemo(() =>
    (nativeDoc()?.boards ?? []).filter((b) => !b.deleted && (b.integrations ?? []).length > 0));
  const nativeHasEnabledIntegrations = createMemo(() =>
    nativeBoardsWithIntegrations().some((b) => b.integrations!.some((c) => c.enabled)));
  const [pending, setPending] = createSignal<PendingImport | null>(null);

  let fileInputRef!: HTMLInputElement;
  let cameraInputRef!: HTMLInputElement;
  const isTouchDevice = "ontouchstart" in window;

  // Reread on each open, since another tab or an earlier session may have left
  // a capture behind.
  createEffect(() => {
    if (props.open) void loadPending().then(setPending);
  });

  onMount(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (phase() !== "idle") return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
      if (file) { e.preventDefault(); processFile(file); }
    };
    document.addEventListener("paste", onPaste);
    onCleanup(() => document.removeEventListener("paste", onPaste));
  });

  const allItems = createMemo(() => preview().flatMap((c) => c.lists.flatMap((l) => l.items)));
  const totalNew = createMemo(() => newCountOf(allItems()));
  const totalSkip = createMemo(() => kept(allItems()).filter((i) => i.skip).length);
  const totalDropped = createMemo(() => allItems().filter((i) => !i.keep).length);

  const toggleKeep = (boardIndex: number, listIndex: number, itemIndex: number) => {
    setPreview((boards) => boards.map((board, b) => b !== boardIndex ? board : {
      ...board,
      lists: board.lists.map((list, l) => l !== listIndex ? list : {
        ...list,
        items: list.items.map((item, i) => i !== itemIndex ? item : { ...item, keep: !item.keep }),
      }),
    }));
  };

  const reset = () => {
    setPhase("idle");
    setError(null);
    setPreview([]);
    setRawJson(null);
    setShowRaw(false);
    setNativeDoc(null);
    setNativeStats(null);
    setNativeResult(null);
    setImportIntegrations(DEFAULT_IMPORT_OPTIONS.integrations);
  };

  const handleClose = () => { reset(); props.onClose(); };

  const processNativeJson = async (file: File) => {
    setError(null);
    setPhase("extracting");
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!isNativeExport(obj)) {
        setError("Not a Listr export file (missing listr_export marker).");
        setPhase("idle");
        return;
      }
      const stats = await previewNativeImport(obj);
      setNativeDoc(obj);
      setNativeStats(stats);
      setPhase("native_preview");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  // Extraction can fail for reasons the image is not at fault for: every model
  // down, or no network. Park the capture so it can go again rather than
  // making the user find the screenshot a second time.
  const submitImage = async (image: string, mimeType: string, scope: ImportScope, retryingPending: boolean) => {
    setError(null);
    setPhase("extracting");

    const park = async (reason: string) => {
      setPending(await savePending(image, mimeType, scope, reason));
      setError(reason);
      setPhase("idle");
    };

    if (!navigator.onLine) {
      await park("Offline, so this screenshot is saved. Retry it when you are back online.");
      return;
    }
    try {
      const { boards: extracted, raw } = await fetchExtraction(image, mimeType, scope);
      setRawJson(raw);
      setPreview(await buildPreview(extracted, scope));
      if (retryingPending) {
        await clearPending();
        setPending(null);
      }
      setPhase("preview");
    } catch (e) {
      await park(e instanceof Error ? e.message : String(e));
    }
  };

  const processFile = async (file: File) => {
    const isJson = file.type === "application/json" || file.name.endsWith(".json");
    if (isJson) { await processNativeJson(file); return; }
    if (!file.type.startsWith("image/")) { setError("Please select an image or JSON export file."); return; }
    setError(null);
    setPhase("extracting");
    try {
      const { base64, mimeType } = await resizeAndEncodeImage(file);
      await submitImage(base64, mimeType, props.scope, false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const retryPending = async () => {
    const p = pending();
    if (p) await submitImage(p.image, p.mime_type, p.scope, true);
  };

  const discardPending = async () => {
    await clearPending();
    setPending(null);
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

  const handleNativeConfirm = async () => {
    const doc = nativeDoc();
    if (!doc) return;
    setPhase("importing");
    try {
      const result = await applyNativeImport(doc, { integrations: importIntegrations() });
      setNativeResult(result);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("native_preview");
    }
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const file = e.dataTransfer?.files[0];
    if (file) await processFile(file);
  };

  const scopeLabel = () =>
    props.scope.type === "board" || props.scope.type === "list"
      ? `into "${props.scope.name}"`
      : "globally";

  return (
    <Modal open={props.open} onClose={handleClose} class="import-modal">
      <div class="modal-page-header">
        <button class="modal-page-back" type="button" onClick={handleClose} aria-label="Back">←</button>
        <span class="modal-page-title">Import</span>
      </div>
      <h2>Import</h2>
      <div class="import-modal-body">

      <Show when={phase() === "idle" || phase() === "extracting"}>
        <p class="field-hint field-hint-lead">
          Drop a screenshot to extract with AI {scopeLabel()}, or drop a Listr JSON export to apply directly.
        </p>
        <Show when={pending()}>
          {(p) => (
            <div class="import-pending" data-testid="pending-import">
              <img class="import-pending-thumb" src={`data:${p().mime_type};base64,${p().image}`} alt="Screenshot waiting to be imported" />
              <div class="import-pending-body">
                <div class="import-pending-title">
                  Screenshot waiting, captured {whenLabel(p().created_at)} {scopeName(p().scope)}
                </div>
                <div class="field-hint">{p().reason}</div>
                <div class="field-hint">Importing another screenshot replaces this one.</div>
              </div>
              <div class="import-pending-actions">
                <button class="btn-primary btn-xs" disabled={phase() === "extracting"} onClick={retryPending}>Retry</button>
                <button class="btn-ghost btn-xs" disabled={phase() === "extracting"} onClick={discardPending}>Discard</button>
              </div>
            </div>
          )}
        </Show>
        <div
          class="dropzone import-dropzone"
          classList={{ dragging: dragging(), loading: phase() === "extracting" }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
          onDragLeave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDragging(false); }}
          onDrop={handleDrop}
          onClick={() => phase() === "idle" && fileInputRef.click()}
        >
          <Show when={phase() === "extracting"} fallback={
            <div class="import-dropzone-hint">
              <div class="big-glyph">📷</div>
              <div>Drop screenshot, paste, or click to select</div>
              <div class="field-hint">Image: AI extraction &nbsp;·&nbsp; JSON: direct apply</div>
            </div>
          }>
            <div class="import-dropzone-hint">
              <div class="big-glyph">⏳</div>
              <div>Processing...</div>
            </div>
          </Show>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*,.json" hidden
          onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processFile(f); e.currentTarget.value = ""; }} />
        <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" hidden
          onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processFile(f); e.currentTarget.value = ""; }} />
        <Show when={error()}>
          {(err) => <div class="field-error" role="alert">{err()}</div>}
        </Show>
        <div class="actions">
          <button class="btn-ghost" onClick={handleClose}>Cancel</button>
          <Show when={isTouchDevice}>
            <button class="btn-ghost" disabled={phase() === "extracting"} onClick={() => cameraInputRef.click()}>
              Take photo
            </button>
          </Show>
          <button class="btn-ghost" disabled={phase() === "extracting"} onClick={() => fileInputRef.click()}>
            Choose file…
          </button>
        </div>
      </Show>

      <Show when={phase() === "native_preview"}>
        <>
          <p class="field-hint field-hint-lead">
            Applying this export will upsert entities by ID. Items not in the export are left untouched.
          </p>
          <Show when={nativeStats()}>
            {(s) => (
              <table class="import-native-stats">
                <thead>
                  <tr><th></th><th>update</th><th>create</th><th>delete</th></tr>
                </thead>
                <tbody>
                  <tr><td>Boards</td><td>{s().boards.updated}</td><td>{s().boards.created}</td><td>{s().boards.deleted}</td></tr>
                  <tr><td>Lists</td><td>{s().lists.updated}</td><td>{s().lists.created}</td><td>{s().lists.deleted}</td></tr>
                  <tr><td>Items</td><td>{s().items.updated}</td><td>{s().items.created}</td><td>{s().items.deleted}</td></tr>
                  <Show when={s().assets.created + s().assets.skipped > 0}>
                    <tr><td>Assets</td><td>{s().assets.skipped} present</td><td>{s().assets.created}</td><td>&mdash;</td></tr>
                  </Show>
                </tbody>
              </table>
            )}
          </Show>
          <Show when={nativeBoardsWithIntegrations().length > 0}>
            <fieldset class="form-field clone-options">
              <legend class="field-label">Integrations</legend>
              <div class="field-hint">
                {nativeBoardsWithIntegrations().length === 1
                  ? "One board in this file has integration settings."
                  : `${nativeBoardsWithIntegrations().length} boards in this file have integration settings.`}
              </div>
              <label class="check-label">
                <input type="radio" name="import-integrations" checked={importIntegrations() === "none"} onChange={() => setImportIntegrations("none")} />
                Leave them out
              </label>
              <label class="check-label">
                <input type="radio" name="import-integrations" checked={importIntegrations() === "copy"} onChange={() => setImportIntegrations("copy")} />
                Import them as they are
              </label>
              <label class="check-label">
                <input type="radio" name="import-integrations" checked={importIntegrations() === "disabled"} onChange={() => setImportIntegrations("disabled")} />
                Import them all disabled
              </label>
              <div class="field-hint">
                <Show
                  when={importIntegrations() === "none"}
                  fallback={
                    <Show when={importIntegrations() === "copy" && nativeHasEnabledIntegrations()}>
                      Items on those boards are looked up again, which uses the integrations' API calls.
                    </Show>
                  }
                >
                  Boards that already exist here keep their own integrations.
                </Show>
              </div>
            </fieldset>
          </Show>
          <Show when={error()}>
            {(err) => <div class="field-error" role="alert">{err()}</div>}
          </Show>
          <div class="actions">
            <button class="btn-ghost" onClick={reset}>Back</button>
            <button class="btn-primary" onClick={handleNativeConfirm}>Apply</button>
          </div>
        </>
      </Show>

      <Show when={phase() === "preview" || phase() === "importing"}>
        <div class="import-summary">
          <strong>{totalNew()}</strong> new item{totalNew() !== 1 ? "s" : ""} to add.
          <Show when={totalSkip() > 0}>
            {" "}<span class="text-muted">{totalSkip()} already exist{totalSkip() === 1 ? "s" : ""} and will be skipped.</span>
          </Show>
          <Show when={totalDropped() > 0}>
            {" "}<span class="text-muted">{totalDropped()} unchecked and will be dropped.</span>
          </Show>
        </div>
        <div class="import-preview">
          <For each={preview()}>
            {(board, boardIndex) => (
              <>
                <Show when={props.scope.type !== "list"}>
                  <div class="import-preview-board">
                    {board.name}
                    <Show when={!board.existingId}>
                      {" "}<span class="badge tone-accent">new board</span>
                    </Show>
                  </div>
                </Show>
                <For each={board.lists}>
                  {(list, listIndex) => (
                    <>
                      <div class="import-preview-list">
                        {list.name}
                        <Show when={!list.existingId}>
                          {" "}<span class="badge tone-accent">new list</span>
                        </Show>
                        {" "}
                        <span class="text-muted">({newCountOf(list.items)} new{list.items.length - newCountOf(list.items) > 0 ? `, ${list.items.length - newCountOf(list.items)} skip` : ""})</span>
                      </div>
                      <For each={list.items}>
                        {(item, itemIndex) => (
                          <div class="import-preview-item" classList={{ skip: item.skip, dropped: !item.keep }}>
                            <input
                              type="checkbox"
                              class="import-keep-checkbox"
                              checked={item.keep}
                              aria-label={`Keep ${item.title}`}
                              disabled={phase() === "importing"}
                              onChange={() => toggleKeep(boardIndex(), listIndex(), itemIndex())}
                            />
                            <span class={item.skip ? "badge tone-muted" : "badge tone-accent"}>
                              {item.skip ? "skip" : "new"}
                            </span>
                            <span class="import-item-title">{item.title}</span>
                            <For each={Object.entries(item.attributes).filter(([, v]) => v != null && v !== "")}>
                              {([k, v]) => (
                                <span class="chip">{k}: {String(v)}</span>
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
        <Show when={rawJson()}>
          <div>
            <button type="button" class="btn-ghost btn-xs" onClick={() => setShowRaw((v) => !v)}>
              {showRaw() ? "Hide raw JSON" : "Show raw JSON"}
            </button>
            <Show when={showRaw()}>
              <pre class="import-raw-json">{rawJson()}</pre>
            </Show>
          </div>
        </Show>
        <Show when={error()}>
          {(err) => <div class="field-error" role="alert">{err()}</div>}
        </Show>
        <div class="actions">
          <button class="btn-ghost" onClick={() => { setError(null); setPhase("idle"); }} disabled={phase() === "importing"}>Back</button>
          <button class="btn-primary" onClick={handleConfirm} disabled={phase() === "importing"}>
            {phase() === "importing" ? "Importing..." : `Import ${totalNew()} item${totalNew() !== 1 ? "s" : ""}`}
          </button>
        </div>
      </Show>

      <Show when={phase() === "done"}>
        <div class="import-done">
          <div class="big-glyph">✓</div>
          <Show when={nativeResult()} fallback={
            <div>Imported {importedCount()} item{importedCount() !== 1 ? "s" : ""} successfully.</div>
          }>
            {(r) => <div>{statsLabel(r())}</div>}
          </Show>
        </div>
        <div class="actions">
          <button class="btn-primary" onClick={handleClose}>Done</button>
        </div>
      </Show>

      </div>
    </Modal>
  );
};

export default ImportModal;
