import { type Component, createSignal, Show, For, createMemo, onMount, onCleanup } from "solid-js";
import type { AttributeDefinition } from "@listr/shared";
import { db } from "../db/database.js";
import { createBoard, createList, bulkCreateItems } from "../db/operations.js";
import { isNativeExport, previewNativeImport, applyNativeImport } from "../db/exportImport.js";
import type { NativeExport, ImportStats } from "../db/exportImport.js";
import Modal from "./Modal.js";

export type ImportScope =
  | { type: "global" }
  | { type: "board"; id: string; name: string; schema: AttributeDefinition[]; format_string: string; macros: Record<string, string> }
  | { type: "list"; id: string; name: string; schema: AttributeDefinition[]; format_string: string; macros: Record<string, string> };

interface ImportedItem { title: string; attributes: Record<string, unknown>; }
interface ImportedList { name: string; items: ImportedItem[]; }
interface ImportedBoard { name: string; lists: ImportedList[]; }

interface PreviewItem extends ImportedItem { skip: boolean; }
interface PreviewList { name: string; existingId?: string; items: PreviewItem[]; newCount: number; }
interface PreviewBoard { name: string; existingId?: string; lists: PreviewList[]; }

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

async function fetchExtraction(imageBase64: string, mimeType: string, scope: ImportScope): Promise<ImportedBoard[]> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) throw new Error("No sync server configured. Set up a sync server first — the AI key lives there.");

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

  const data = await resp.json() as any;
  if (!resp.ok) throw new Error(data.error ?? `Server error ${resp.status}`);
  return (data.boards ?? []) as ImportedBoard[];
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
    }));
    return [{
      name: scope.name,
      existingId: scope.id,
      lists: [{ name: scope.name, existingId: scope.id, items, newCount: items.filter((i) => !i.skip).length }],
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
      }));
      return {
        name: list.name,
        existingId: existingList?.id,
        items,
        newCount: items.filter((i) => !i.skip).length,
      };
    });

    return { name: board.name, existingId: existingBoard?.id, lists };
  });
}

async function performImport(preview: PreviewBoard[], scope: ImportScope): Promise<number> {
  if (scope.type === "list") {
    const newItems = preview.flatMap((b) => b.lists.flatMap((l) => l.items.filter((i) => !i.skip)));
    if (newItems.length > 0) await bulkCreateItems(scope.id, newItems);
    return newItems.length;
  }

  let total = 0;
  for (const board of preview) {
    let boardId = board.existingId;
    if (!boardId) {
      const schema = scope.type === "board" ? scope.schema : [];
      const fmt = scope.type === "board" ? scope.format_string : "{title}";
      const macros = scope.type === "board" ? scope.macros : {};
      const newBoard = await createBoard(board.name, "#5b8def", schema, fmt, macros);
      boardId = newBoard.id;
    }
    for (const list of board.lists) {
      let listId = list.existingId;
      if (!listId) {
        const newList = await createList(list.name, boardId);
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
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
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
  return parts.length ? parts.join(" · ") : "nothing to change";
}

const ImportModal: Component<Props> = (props) => {
  type Phase = "idle" | "extracting" | "preview" | "native_preview" | "importing" | "done";
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewBoard[]>([]);
  const [importedCount, setImportedCount] = createSignal(0);
  const [dragging, setDragging] = createSignal(false);
  const [nativeDoc, setNativeDoc] = createSignal<NativeExport | null>(null);
  const [nativeStats, setNativeStats] = createSignal<ImportStats | null>(null);
  const [nativeResult, setNativeResult] = createSignal<ImportStats | null>(null);

  let fileInputRef!: HTMLInputElement;

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

  const reset = () => {
    setPhase("idle");
    setError(null);
    setPreview([]);
    setNativeDoc(null);
    setNativeStats(null);
    setNativeResult(null);
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

  const processFile = async (file: File) => {
    const isJson = file.type === "application/json" || file.name.endsWith(".json");
    if (isJson) { await processNativeJson(file); return; }
    if (!file.type.startsWith("image/")) { setError("Please select an image or JSON export file."); return; }
    setError(null);
    setPhase("extracting");
    try {
      const base64 = await fileToBase64(file);
      const extracted = await fetchExtraction(base64, file.type, props.scope);
      const prev = await buildPreview(extracted, props.scope);
      setPreview(prev);
      setPhase("preview");
    } catch (e) {
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

  const handleNativeConfirm = async () => {
    const doc = nativeDoc();
    if (!doc) return;
    setPhase("importing");
    try {
      const result = await applyNativeImport(doc);
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
    <Modal open={props.open} onClose={handleClose}>
      <h2>Import</h2>

      <Show when={phase() === "idle" || phase() === "extracting"}>
        <p class="field-hint" style="margin-bottom: 12px">
          Drop a screenshot to extract with AI {scopeLabel()}, or drop a Listr JSON export to apply directly.
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
              <div>Drop screenshot, paste, or click to select</div>
              <div class="field-hint" style="margin-top: 4px">Image: AI extraction &nbsp;·&nbsp; JSON: direct apply</div>
            </div>
          }>
            <div class="import-dropzone-hint">
              <div style="font-size: 1.5em; margin-bottom: 8px">⏳</div>
              <div>Processing...</div>
            </div>
          </Show>
        </div>
        <input ref={fileInputRef} type="file" accept="image/*,.json" style="display:none"
          onChange={(e) => { const f = e.currentTarget.files?.[0]; if (f) processFile(f); e.currentTarget.value = ""; }} />
        <Show when={error()}>
          {(err) => <div class="field-error" style="margin-top: 8px">{err()}</div>}
        </Show>
        <div class="modal-actions">
          <button class="btn-ghost" onClick={handleClose}>Cancel</button>
        </div>
      </Show>

      <Show when={phase() === "native_preview"}>
        {() => {
          const stats = nativeStats();
          return (
            <>
              <p class="field-hint" style="margin-bottom: 16px">
                Applying this export will upsert entities by ID. Items not in the export are left untouched.
              </p>
              <Show when={stats}>
                {(s) => (
                  <table class="import-native-stats">
                    <thead>
                      <tr><th></th><th>update</th><th>create</th><th>delete</th></tr>
                    </thead>
                    <tbody>
                      <tr><td>Boards</td><td>{s().boards.updated}</td><td>{s().boards.created}</td><td>{s().boards.deleted}</td></tr>
                      <tr><td>Lists</td><td>{s().lists.updated}</td><td>{s().lists.created}</td><td>{s().lists.deleted}</td></tr>
                      <tr><td>Items</td><td>{s().items.updated}</td><td>{s().items.created}</td><td>{s().items.deleted}</td></tr>
                    </tbody>
                  </table>
                )}
              </Show>
              <Show when={error()}>
                {(err) => <div class="field-error" style="margin-top: 8px">{err()}</div>}
              </Show>
              <div class="modal-actions">
                <button class="btn-ghost" onClick={reset}>Back</button>
                <button class="btn-primary" onClick={handleNativeConfirm}>Apply</button>
              </div>
            </>
          );
        }}
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
            {(board) => (
              <>
                <Show when={props.scope.type !== "list"}>
                  <div class="import-preview-board">
                    {board.name}
                    <Show when={!board.existingId}>
                      {" "}<span class="badge badge-new">new board</span>
                    </Show>
                  </div>
                </Show>
                <For each={board.lists}>
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
          <Show when={nativeResult()} fallback={
            <div>Imported {importedCount()} item{importedCount() !== 1 ? "s" : ""} successfully.</div>
          }>
            {(r) => <div>{statsLabel(r())}</div>}
          </Show>
        </div>
        <div class="modal-actions">
          <button class="btn-primary" onClick={handleClose}>Done</button>
        </div>
      </Show>
    </Modal>
  );
};

export default ImportModal;
