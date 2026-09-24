import { type Component, For, Show, Switch, Match, createSignal, createEffect, createMemo, onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { from } from "solid-js";
import { useParams, useLocation } from "@solidjs/router";
import { liveQuery } from "dexie";
import { applyPick, compileFormat, computeOverlay, resolveOverlay, effectiveValue, effectiveValues, orderResults, upgradeBoardRecord, withOverlay, type CompiledFormat, type Overlay, type RenderedFormat } from "@listr/shared";
import type { AttributeDefinition, Board, Integration, IntegrationResult, Item, List, IntegrationStatus, TodoState } from "@listr/shared";
import { db } from "../db/database.js";
import { createItem, updateItem, updateItemAttribute, deleteItem, updateList, deleteList, createList, resolveChain, updateBoard, deleteBoard, computeCrossListMove } from "../db/operations.js";
import { exportList, exportBoard } from "../db/exportImport.js";
import { triggerDownload } from "../utils/download.js";
import { menuPosition } from "../utils/menuPosition.js";
import ImportModal from "../components/ImportModal.js";
import type { ImportScope } from "../components/ImportModal.js";
import { syncClient } from "../sync/SyncClient.js";
import { assetUrls } from "../sync/assetStore.js";
import { selectedListIds, setSelectedListIds } from "../store/sidebarSelection.js";
import { appViewMode, setAppViewMode } from "../store/viewMode.js";
import { themePref, setThemePref, type ThemePreference } from "../store/theme.js";
import { selectionMode, setSelectionMode } from "../store/selectionMode.js";
import { useSortable, isDragging } from "../hooks/useSortable.js";
import InlineAddItem, { DUMMY_ITEM_ID } from "../components/InlineAddItem.js";
import ItemFormModal from "../components/ItemFormModal.js";
import IntegrationChoiceModal from "../components/IntegrationChoiceModal.js";
import { availableIntegrations } from "../store/integrationCatalog.js";
import MultiItemFormModal from "../components/MultiItemFormModal.js";
import ListFormModal, { type ListFormData } from "../components/ListFormModal.js";
import BoardFormModal, { type BoardFormData } from "../components/BoardFormModal.js";
import FormattedText from "../components/FormattedText.js";
import ContextMenu from "../components/ContextMenu.js";
import type { MenuItem } from "../components/ContextMenu.js";
import MoveToListModal from "../components/MoveToListModal.js";
import BoardShareModal from "../components/BoardShareModal.js";
import CloneBoardModal from "../components/CloneBoardModal.js";
import ShareIcon from "../components/ShareIcon.js";

// Stable sentinel object for the inline-add dummy row. Using a single reference
// lets SolidJS <For> reuse the DOM node when the dummy changes position.
type DummyShim = { id: typeof DUMMY_ITEM_ID; after_id: string | null; created_at: 0 };
const DUMMY_SHIM: DummyShim = { id: DUMMY_ITEM_ID, after_id: null, created_at: 0 };

const TODO_LABELS: Record<TodoState, string> = {
  default: "To do",
  done: "Done",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const VIEW_MODES: { mode: "list" | "table" | "card"; label: string }[] = [
  { mode: "list", label: "List" },
  { mode: "table", label: "Table" },
  { mode: "card", label: "Cards" },
];

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System default" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "high-contrast", label: "High contrast dark" },
];

const formatCellValue = (value: unknown, type: string): string => {
  if (value == null || value === "") return "\u2014";
  if (type === "boolean") return value ? "Yes" : "No";
  if (type === "duration") {
    const n = Number(value);
    const h = Math.floor(n / 60);
    const m = n % 60;
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }
  if (type === "tags" && Array.isArray(value)) return value.join(", ");
  if (type === "todo") {
    const labels: Record<string, string> = { default: "To do", done: "Done", cancelled: "Cancel", skipped: "Skip" };
    return labels[String(value)] ?? String(value);
  }
  return String(value);
};

const TodoIcon = ({ state }: { state: TodoState }) => {
  if (state === "done") return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke-width="1.5"/>
      <path d="M5 8.5L7 10.5L11 5.5" stroke-width="2"/>
    </svg>
  );
  if (state === "cancelled") return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke-width="1.5"/>
      <line x1="5" y1="8" x2="11" y2="8" stroke-width="2"/>
    </svg>
  );
  if (state === "skipped") return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round">
      <path d="M6 3C3.5 5 3.5 11 6 13" stroke-width="1.5"/>
      <path d="M10 3C12.5 5 12.5 11 10 13" stroke-width="1.5"/>
    </svg>
  );
  // default: empty checkbox
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" stroke-width="1.5"/>
    </svg>
  );
};


const ListView: Component = () => {
  const params = useParams();
  const location = useLocation();

  // DB-subscribed state — populated by liveQuery effects below
  const [board, setBoard] = createSignal<Board | undefined>();
  const [allLists, setAllLists] = createSignal<List[]>([]);
  const [itemsByList, setItemsByList] = createSignal<Map<string, Item[]>>(new Map());
  // Integration results for this board's items, grouped by item_id.
  const [resultsByItemId, setResultsByItemId] = createSignal<Map<string, IntegrationResult[]>>(new Map());
  // Each item's winning integration values. Only items with results have an
  // entry, and reconcile keeps unchanged entries, so only affected readers rerun.
  const [overlays, setOverlays] = createStore<Record<string, Overlay>>({});
  // The item whose ambiguous result is being resolved in the picker.
  const [pickingItemId, setPickingItemId] = createSignal<string | null>(null);

  // Item add/edit modal state
  const [addingToList, setAddingToList] = createSignal<string | null>(null); // list id receiving a new item, or null
  const [addingInitialTitle, setAddingInitialTitle] = createSignal("");      // pre-fill title when expanding from inline add

  // Inline add dummy positions: listId → after_id (absent = default to tail)
  const [dummyAfterIds, setDummyAfterIds] = createSignal<Map<string, string | null>>(new Map());

  const setDummyAfterId = (listId: string, afterId: string | null) =>
    setDummyAfterIds((prev) => new Map(prev).set(listId, afterId));

  // Reset to tail: remove the explicit position so resolvedDummyAfterId falls back to the tail.
  const resetDummyAfterId = (listId: string) =>
    setDummyAfterIds((prev) => { const next = new Map(prev); next.delete(listId); return next; });

  // Returns the dummy's current after_id for a list; defaults to the tail item's id if unset.
  const resolvedDummyAfterId = (listId: string): string | null => {
    const map = dummyAfterIds();
    if (map.has(listId)) return map.get(listId)!;
    const items = itemsByList().get(listId) ?? [];
    return items.length > 0 ? items[items.length - 1].id : null;
  };

  const [editingItem, setEditingItem] = createSignal<Item | undefined>();    // item open in edit modal
  const [editingList, setEditingList] = createSignal<List | undefined>();    // list open in settings modal
  const [editingBoard, setEditingBoard] = createSignal<Board | undefined>(); // board open in settings modal
  const [boardCtxMenu, setBoardCtxMenu] = createSignal<{ x: number; y: number } | null>(null);
  const [sharingBoard, setSharingBoard] = createSignal<Board | undefined>();
  const [cloningBoard, setCloningBoard] = createSignal<Board | undefined>();
  const [boardImportScope, setBoardImportScope] = createSignal<ImportScope | null>(null);
  const [listCtxMenu, setListCtxMenu] = createSignal<{ x: number; y: number; list: List } | null>(null);
  const [listImportScope, setListImportScope] = createSignal<ImportScope | null>(null);

  // Selection state
  const [selectedItemIds, setSelectedItemIds] = createSignal<Set<string>>(new Set());
  const [anchorItemId, setAnchorItemId] = createSignal<string | null>(null); // shift-click range anchor
  const [itemCtxMenu, setItemCtxMenu] = createSignal<{ x: number; y: number; item: Item } | null>(null);
  const [todoCtxMenu, setTodoCtxMenu] = createSignal<{ x: number; y: number; item: Item; attrKey: string } | null>(null);
  const [showMultiEdit, setShowMultiEdit] = createSignal(false);             // multi-edit modal open
  const [showMoveToList, setShowMoveToList] = createSignal(false);           // move-to-list picker open

  // Filter
  const [filterQuery, setFilterQuery] = createSignal("");
  const [filterOpen, setFilterOpen] = createSignal(false); // mobile: filter bar expanded
  const [configOpen, setConfigOpen] = createSignal(false); // mobile: config sheet open

  let multiListViewEl: HTMLElement | undefined;

  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  // Touch interaction bookkeeping (not signals — no reactive subscribers need these)
  let lastTapItemId: string | null = null;  // for double-tap-to-edit detection
  let lastTapTime = 0;
  let lastTapListId: string | null = null;  // for double-tap list header to edit
  let lastTapListTime = 0;
  let lastContextMenuTime = 0;              // suppresses click fired after a long-press contextmenu
  let touchSelectTimer: ReturnType<typeof setTimeout> | null = null; // pending delayed selection
  let todoLongPressTimer: ReturnType<typeof setTimeout> | null = null;
  let touchStartX = 0;
  let touchStartY = 0;

  // Background drag-to-scroll (desktop): mousedown on empty board background pans horizontally.
  let bgScrollDragging = false;
  let bgScrollStartX = 0;
  let bgScrollStartLeft = 0;

  const handleBoardBackgroundMove = (e: MouseEvent) => {
    if (!bgScrollDragging || !multiListViewEl) return;
    multiListViewEl.scrollLeft = bgScrollStartLeft - (e.clientX - bgScrollStartX);
  };

  const handleBoardBackgroundUp = () => {
    if (!bgScrollDragging || !multiListViewEl) return;
    bgScrollDragging = false;
    multiListViewEl.classList.remove("bg-scroll-dragging");
    window.removeEventListener("mousemove", handleBoardBackgroundMove);
    window.removeEventListener("mouseup", handleBoardBackgroundUp);

    // Settle into the nearest snap column now that the drag is done (mirrors useSortable's
    // edge-scroll-end behavior: scrollSnapType stays "none" until the animation completes).
    const el = multiListViewEl;
    const sl = el.scrollLeft;
    // Columns only; the trailing "+ New list" button is not a snap target.
    const cols = Array.from(el.querySelectorAll<HTMLElement>(":scope > .multi-list-column"));
    const nearestLeft = cols.reduce(
      (best, col) => Math.abs(col.offsetLeft - sl) < Math.abs(best - sl) ? col.offsetLeft : best,
      cols[0]?.offsetLeft ?? sl,
    );
    if (cols.length > 0 && Math.abs(nearestLeft - sl) > 1) {
      el.addEventListener("scrollend", () => { el.style.scrollSnapType = ""; }, { once: true });
      el.scrollTo({ left: nearestLeft, behavior: "smooth" });
    } else {
      el.style.scrollSnapType = "";
    }
  };

  const handleBoardBackgroundDown = (e: MouseEvent) => {
    // Only plain left-click drags on the board background itself (not a list/column/button
    // inside it), only in horizontal (list) view mode, and never while an item is being dragged.
    if (e.button !== 0 || isTouch || isDragging()) return;
    if (e.target !== multiListViewEl || appViewMode() !== "list" || !multiListViewEl) return;
    e.preventDefault(); // avoid text-selection while dragging over column contents
    bgScrollDragging = true;
    bgScrollStartX = e.clientX;
    bgScrollStartLeft = multiListViewEl.scrollLeft;
    multiListViewEl.style.scrollSnapType = "none";
    multiListViewEl.classList.add("bg-scroll-dragging");
    window.addEventListener("mousemove", handleBoardBackgroundMove);
    window.addEventListener("mouseup", handleBoardBackgroundUp);
  };

  const allBoards = from(liveQuery(() => db.boards.orderBy("position").toArray()));

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedItemIds(new Set<string>());
  };

  // Auto-exit selection mode when all items are deselected; clear selection when mode is exited from outside
  createEffect(() => {
    if (selectionMode() && selectedItemIds().size === 0) setSelectionMode(false);
    if (!selectionMode()) setSelectedItemIds(new Set<string>());
  });

  const handleGlobalKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      exitSelectionMode();
      setItemCtxMenu(null);
    }
  };
  document.addEventListener("keydown", handleGlobalKeyDown);
  onCleanup(() => document.removeEventListener("keydown", handleGlobalKeyDown));

  // Reset per-board state when navigating to a different board
  createEffect(() => {
    if (!params.id) return; // Help the type system.
    const boardId = params.id;
    setSelectedItemIds(new Set<string>());
    setSelectionMode(false);
    setItemCtxMenu(null);
    setFilterQuery("");
    setFilterOpen(false);
    setEditingList(undefined);
    setDummyAfterIds(new Map());

    const sub1 = liveQuery(() => db.boards.get(boardId)).subscribe((v) => setBoard(v));
    const sub2 = liveQuery(() =>
      db.lists.where("board_id").equals(boardId).sortBy("position")
    ).subscribe((v) => setAllLists(v));
    onCleanup(() => { sub1.unsubscribe(); sub2.unsubscribe(); });
  });

  // Watch location.state for openSettings
  createEffect(() => {
    const state = location.state as any;
    if (state?.openSettings) {
      const listId = state.openSettings as string;
      const list = allLists().find((l) => l.id === listId);
      if (list) setEditingList(list);
    }
  });

  createEffect(() => {
    const listIds = allLists().map((l) => l.id);
    if (!listIds.length) { setItemsByList(new Map()); setResultsByItemId(new Map()); return; }
    const sub = liveQuery(async () => {
      const map = new Map<string, Item[]>();
      await Promise.all(listIds.map(async (id) => {
        const rawItems = await db.items.where("list_id").equals(id).toArray();
        map.set(id, resolveChain(rawItems)); // chain order
      }));
      return map;
    }).subscribe((v) => setItemsByList(v));
    onCleanup(() => sub.unsubscribe());
  });

  // Subscribe to integration results for items in this board
  createEffect(() => {
    const allItemIds = [...itemsByList().values()].flatMap((items) => items.map((i) => i.id));
    if (!allItemIds.length) { setResultsByItemId(new Map()); return; }
    const sub = liveQuery(async () => {
      const results = await db.integration_results.where("item_id").anyOf(allItemIds).toArray();
      const map = new Map<string, IntegrationResult[]>();
      for (const r of results) {
        const list = map.get(r.item_id);
        if (list) list.push(r);
        else map.set(r.item_id, [r]);
      }
      return map;
    }).subscribe((v) => setResultsByItemId(v ?? new Map()));
    onCleanup(() => sub.unsubscribe());
  });

  // Recompute overlays from results, item picks and the board's integration order and schema.
  createEffect(() => {
    const b = board();
    const sch = schema();
    const byId = new Map([...itemsByList().values()].flat().map((i) => [i.id, i]));
    const next: Record<string, Overlay> = {};
    for (const [itemId, results] of resultsByItemId()) {
      const item = byId.get(itemId);
      if (!item) continue;
      const overlay = computeOverlay(item, orderResults(results, b?.integrations), sch);
      if (overlay) next[itemId] = overlay;
    }
    setOverlays(reconcile(next));
  });

  const STATUS_PRIORITY: IntegrationStatus[] = ["error", "ambiguous", "not_found", "unprocessed", "complete"];

  /** The most urgent result for an item, among the board's enabled integrations. */
  const worstResult = (itemId: string): IntegrationResult | undefined => {
    const results = orderResults(resultsByItemId().get(itemId) ?? [], board()?.integrations);
    let worst: IntegrationResult | undefined;
    for (const r of results) {
      if (!worst || STATUS_PRIORITY.indexOf(r.status) < STATUS_PRIORITY.indexOf(worst.status)) worst = r;
    }
    return worst;
  };

  /** Which integration each overlay value of the item being edited came from, by display name. */
  const editingSources = createMemo(() => {
    const item = editingItem();
    if (!item) return undefined;
    const resolved = resolveOverlay(item, orderResults(resultsByItemId().get(item.id) ?? [], board()?.integrations), schema());
    if (!resolved) return undefined;
    const names = new Map(availableIntegrations().map((m) => [m.id, m.name]));
    return Object.fromEntries(Object.entries(resolved.sources).map(([key, id]) => [key, names.get(id) ?? id]));
  });

  /** The item as readers see it, with integration values overlaid. */
  const shown = (item: Item): Item => withOverlay(item, overlays[item.id]);

  createEffect(() => {
    const [id] = selectedListIds();
    if (!id || !multiListViewEl) return;
    const col = multiListViewEl.querySelector<HTMLElement>(`[data-list-id="${id}"]`);
    col?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
  });

  const visibleLists = allLists;

  // Cap horizontal scrolling at the last list. Mandatory snapping rests on that
  // column only when its snap position is reachable, which takes a viewport's
  // worth of content past it; the column itself and the "+ New list" button
  // cover part of that, and the tail spacer makes up the rest. Measured rather
  // than expressed in CSS, so a board that already fits gains no slack.
  const updateBoardTail = () => {
    const el = multiListViewEl;
    if (!el) return;
    el.style.setProperty("--board-tail", "0px");
    const cols = el.querySelectorAll<HTMLElement>(":scope > .multi-list-column");
    const last = cols[cols.length - 1];
    if (!last) return;
    const overflow = el.scrollWidth - el.clientWidth; // measured with no tail
    if (overflow <= 0) return;
    el.style.setProperty("--board-tail", `${Math.max(0, last.offsetLeft - overflow)}px`);
  };

  let boardResizeObs: ResizeObserver | undefined;
  const observeBoardWidth = (el: HTMLElement) => {
    boardResizeObs?.disconnect();
    boardResizeObs = new ResizeObserver(updateBoardTail);
    boardResizeObs.observe(el);
  };
  onCleanup(() => boardResizeObs?.disconnect());

  // Columns come and go, and each view mode lays them out differently.
  createEffect(() => {
    visibleLists();
    appViewMode();
    updateBoardTail();
  });

  const headerTitle = () => board()?.name ?? "";

  // Keep the document title on the board being viewed, so tab lists and screen
  // reader page announcements say which board this is.
  createEffect(() => {
    const name = board()?.name;
    document.title = name ? `${name} - Listr` : "Listr";
  });

  const schema = createMemo((): AttributeDefinition[] => {
    const b = board();
    if (!b) return [];
    return [...b.schema].sort((a, b) => a.position - b.position);
  });

  const boardFormatText = createMemo(() => {
    const b = board();
    return b ? upgradeBoardRecord(b).format.text : "[title]";
  });

  // Compile the board format and each distinct list override once per
  // board format and schema, not once per item. An override inherits the
  // board's directives and definitions.
  const compiledFormat = createMemo(() => {
    const sch = schema();
    const base = boardFormatText();
    const board = compileFormat(base, sch);
    const overrides = new Map<string, CompiledFormat>();
    return (override: string | undefined): CompiledFormat => {
      if (override === undefined) return board;
      let c = overrides.get(override);
      if (!c) overrides.set(override, (c = compileFormat(override, sch, base)));
      return c;
    };
  });

  const formatItem = (item: Item, list: List): RenderedFormat => {
    const urls = assetUrls();
    return compiledFormat()(list.format?.text).render(shown(item), { urlResolver: (url) => urls[url] ?? url });
  };

  const ItemText: Component<{ item: Item; list: List }> = (p) => {
    const rendered = createMemo(() => formatItem(p.item, p.list));
    return <FormattedText html={rendered().html} tooltip={rendered().tooltip} />;
  };

  const todoAttr = createMemo(() => schema().find((a) => a.type === "todo"));

  const getTodoState = (item: Item): TodoState => {
    const attr = todoAttr();
    if (!attr) return "default";
    const v = item.attributes[attr.key];
    return (typeof v === "string" ? v : "default") as TodoState;
  };

  const todoCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = todoCtxMenu();
    if (!ctx) return [];
    const states: Array<{ state: TodoState; label: string }> = [
      { state: "default", label: "Todo" },
      { state: "done", label: "Done" },
      { state: "cancelled", label: "Cancel" },
      { state: "skipped", label: "Skip" },
    ];
    return states.map(({ state, label }) => ({
      label,
      action: async () => {
        setTodoCtxMenu(null);
        await updateItemAttribute(ctx.item.id, ctx.attrKey, state === "default" ? undefined : state);
      },
    }));
  });

  const integrationBadge = (itemId: string) => {
    const r = worstResult(itemId);
    if (!r || r.status === "complete") return null;
    if (r.status === "unprocessed") {
      const title = r.error === "quota" ? "Integration waiting for tomorrow's API quota" : "Integration processing\u2026";
      return <span class="badge badge-round tone-muted is-spinning" title={title}>{"\u21bb"}</span>;
    }
    if (r.status === "error") return <span class="badge badge-round tone-danger" title={`Integration error: ${r.error ?? "unknown"}`}>!</span>;
    if (r.status === "not_found") return <span class="badge badge-round tone-muted" title="Integration found no match">{"\u2205"}</span>;
    if (r.status === "ambiguous") {
      return (
        <button
          type="button"
          class="btn-bare badge badge-round tone-warning"
          title="Several matches. Choose one."
          aria-label="Several integration matches. Choose one."
          onClick={(e) => { e.stopPropagation(); setPickingItemId(itemId); }}
          onDblClick={(e) => e.stopPropagation()}
        >
          ?
        </button>
      );
    }
    return null;
  };

  const pickingItem = createMemo(() => {
    const id = pickingItemId();
    return id ? [...itemsByList().values()].flat().find((i) => i.id === id) : undefined;
  });

  const handlePick = async (attr: string, choice: { options_key: string; releases?: string[] }, value: string) => {
    const item = pickingItem();
    setPickingItemId(null);
    if (item) await updateItem(item.id, applyPick(item, attr, choice, value));
  };

  const itemsForList = (listId: string): Item[] => {
    const allForList = itemsByList().get(listId) ?? [];
    const q = filterQuery().toLowerCase().trim();
    if (!q) return allForList;
    return allForList.filter((item) =>
      effectiveValues(item, overlays[item.id]).some((val) => val != null && String(val).toLowerCase().includes(q)));
  };

  const handleAddItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const listId = addingToList();
    if (!listId) return;
    const afterId = resolvedDummyAfterId(listId);
    const newItem = await createItem(listId, data.title, data.attributes, afterId);
    resetDummyAfterId(listId);
    setAddingToList(null);
    setAddingInitialTitle("");
  };

  const handleEditItem = async (data: { title: string; attributes: Record<string, unknown> }) => {
    const item = editingItem();
    if (!item) return;
    await updateItem(item.id, { title: data.title, attributes: data.attributes });
    setEditingItem(undefined);
  };

  const handleDeleteItem = async () => {
    const item = editingItem();
    if (!item) return;
    await deleteItem(item.id);
    setEditingItem(undefined);
  };

  const handleNewList = async () => {
    const b = board();
    if (!b) return;
    const list = await createList("New List", b.id);
    setEditingList(list);
  };

  const handleEditList = async (data: ListFormData) => {
    const list = editingList();
    if (!list) return;
    await updateList(list.id, data);
    setEditingList(undefined);
  };

  const handleEditBoard = async (data: BoardFormData) => {
    const b = editingBoard();
    if (!b) return;
    await updateBoard(b.id, data);
    setEditingBoard(undefined);
  };

  const boardCtxMenuItems = createMemo((): MenuItem[] => {
    const b = board();
    if (!b) return [];
    return [
      { label: "Edit", action: () => { setBoardCtxMenu(null); setEditingBoard(b); } },
      { label: "Share", action: () => { setBoardCtxMenu(null); setSharingBoard(b); } },
      { label: "Clone", action: () => { setBoardCtxMenu(null); setCloningBoard(b); } },
      { label: "Import", action: () => { setBoardCtxMenu(null); setBoardImportScope({ type: "board", id: b.id, name: b.name, schema: b.schema, format: b.format.text }); } },
      { label: "Export", action: async () => { setBoardCtxMenu(null); const data = await exportBoard(b.id); triggerDownload(data, `listr-board-${b.name}-${new Date().toISOString().slice(0, 10)}.json`); } },
      { label: "Delete", danger: true, action: async () => { setBoardCtxMenu(null); if (!confirm(`Delete "${b.name}" and all its lists and items?`)) return; await deleteBoard(b.id); } },
    ];
  });

  const handleEditFromBar = () => {
    if (selectedItemIds().size === 1) {
      const id = [...selectedItemIds()][0];
      const item = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === id);
      if (item) setEditingItem(item);
    } else {
      setShowMultiEdit(true);
    }
  };

  const handleMultiEditSave = async (attrUpdates: Record<string, unknown>) => {
    const ids = [...selectedItemIds()];
    for (const id of ids) {
      const item = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === id);
      if (!item) continue;
      await updateItem(id, { attributes: { ...item.attributes, ...attrUpdates } });
    }
    setShowMultiEdit(false);
  };

  const handleDeleteSelectedItems = async () => {
    const ids = [...selectedItemIds()];
    if (!confirm(`Delete ${ids.length} item${ids.length !== 1 ? "s" : ""}?`)) return;
    for (const id of ids) await deleteItem(id);
    setSelectedItemIds(new Set<string>());
    setItemCtxMenu(null);
  };

  const listCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = listCtxMenu();
    if (!ctx) return [];
    const { list } = ctx;
    const b = board();
    return [
      { label: "Edit", action: () => { setListCtxMenu(null); setEditingList(list); } },
      { label: "Import", action: () => { setListCtxMenu(null); b && setListImportScope({ type: "list", id: list.id, name: list.name, schema: b.schema, format: (list.format ?? b.format).text }); } },
      { label: "Export", action: async () => { setListCtxMenu(null); const data = await exportList(list.id); triggerDownload(data, `listr-list-${list.name}-${new Date().toISOString().slice(0, 10)}.json`); } },
      { label: "Delete", danger: true, action: async () => { setListCtxMenu(null); if (!confirm(`Delete "${list.name}" and all its items?`)) return; await deleteList(list.id); } },
    ];
  });

  const handleMoveToList = async (targetListId: string) => {
    setShowMoveToList(false);
    // Only move items not already in the target list — picking the same list is a no-op cancel.
    const toMove: Item[] = [];
    for (const items of itemsByList().values()) {
      for (const item of items) {
        if (selectedItemIds().has(item.id) && item.list_id !== targetListId) toMove.push(item);
      }
    }
    if (!toMove.length) return;

    const timestamp = Date.now();
    const movedIds = new Set(toMove.map((i) => i.id));
    const sourceLists = new Set(toMove.map((i) => i.list_id));

    // Append the moved items to the end of the target list's chain, in order.
    const rawTarget = await db.items.where("list_id").equals(targetListId).toArray();
    const targetChain = resolveChain(rawTarget);
    let prevId: string | null = targetChain.length > 0 ? targetChain[targetChain.length - 1].id : null;
    const targetUpdates: { item: Item; after_id: string | null }[] = [];
    for (const item of toMove) {
      targetUpdates.push({ item, after_id: prevId });
      prevId = item.id;
    }

    // Repair each source list: rebuild the chain over the items that remain so
    // no successor is left pointing at a moved-away item.
    const sourceRepairs: { id: string; after_id: string | null }[] = [];
    for (const srcId of sourceLists) {
      const rawSrc = await db.items.where("list_id").equals(srcId).toArray();
      const remaining = resolveChain(rawSrc).filter((i) => !movedIds.has(i.id));
      let p: string | null = null;
      for (const it of remaining) {
        if ((it.after_id ?? null) !== p) sourceRepairs.push({ id: it.id, after_id: p });
        p = it.id;
      }
    }

    await db.transaction("rw", db.items, async () => {
      for (const { item, after_id } of targetUpdates) {
        await db.items.update(item.id, { list_id: targetListId, after_id, updated_at: timestamp });
      }
      for (const { id, after_id } of sourceRepairs) {
        await db.items.update(id, { after_id, updated_at: timestamp });
      }
    });

    for (const { item, after_id } of targetUpdates) {
      syncClient.pushEntity("item", { ...item, list_id: targetListId, after_id, updated_at: timestamp });
    }
    for (const { id } of sourceRepairs) {
      const fresh = await db.items.get(id);
      if (fresh) syncClient.pushEntity("item", fresh);
    }
    exitSelectionMode();
  };

  const itemCtxMenuItems = createMemo((): MenuItem[] => {
    const ctx = itemCtxMenu();
    const menuItems: MenuItem[] = [];
    const n = selectedItemIds().size;
    if (ctx && n === 1 && selectedItemIds().has(ctx.item.id)) {
      // Capture the item now: ContextMenu closes the menu, clearing
      // itemCtxMenu, before it runs the action.
      const { item } = ctx;
      menuItems.push({ label: "Edit Item", action: () => { setEditingItem(item); setItemCtxMenu(null); } });
      // Also offered when an integration chose a match itself, which shows no badge.
      const hasChoices = orderResults(resultsByItemId().get(item.id) ?? [], board()?.integrations).some((r) => r.choices);
      if (hasChoices) {
        menuItems.push({ label: "Choose match", action: () => { setPickingItemId(item.id); setItemCtxMenu(null); } });
      }
    }
    if (n > 1) {
      menuItems.push({ label: `Edit ${n} items`, action: () => { setShowMultiEdit(true); setItemCtxMenu(null); } });
    }
    menuItems.push({ label: "Move to list", action: () => { setShowMoveToList(true); setItemCtxMenu(null); } });
    menuItems.push({ label: `Delete ${n} item${n !== 1 ? "s" : ""}`, danger: true, action: handleDeleteSelectedItems });
    return menuItems;
  });

  const handleItemTouchStart = (e: TouchEvent, item: Item) => {
    if (selectionMode()) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    if (touchSelectTimer) clearTimeout(touchSelectTimer);
    touchSelectTimer = setTimeout(() => {
      touchSelectTimer = null;
      setAnchorItemId(item.id);
      setSelectedItemIds(new Set([item.id]));
    }, 80);
  };

  const handleItemTouchMove = (e: TouchEvent) => {
    if (!touchSelectTimer) return;
    const dx = Math.abs(e.touches[0].clientX - touchStartX);
    const dy = Math.abs(e.touches[0].clientY - touchStartY);
    if (dx > 10 || dy > 10) {
      clearTimeout(touchSelectTimer);
      touchSelectTimer = null;
    }
  };

  const handleItemClick = (e: MouseEvent, item: Item, contextItems: Item[]) => {
    e.stopPropagation();

    if (isTouch) {
      if (Date.now() - lastContextMenuTime < 600) return;
      if (selectionMode()) {
        setAnchorItemId(item.id);
        setSelectedItemIds((prev) => {
          const next = new Set(prev);
          next.has(item.id) ? next.delete(item.id) : next.add(item.id);
          return next;
        });
        return;
      }
      const now = Date.now();
      if (lastTapItemId === item.id && now - lastTapTime < 350) {
        lastTapItemId = null;
        lastTapTime = 0;
        setEditingItem(item);
        return;
      }
      lastTapItemId = item.id;
      lastTapTime = now;
      return;
    }

    if (e.shiftKey && anchorItemId()) {
      const ids = contextItems.map((i) => i.id);
      const a = ids.indexOf(anchorItemId()!);
      const b = ids.indexOf(item.id);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const rangeIds = new Set(ids.slice(lo, hi + 1));
        if (e.ctrlKey || e.metaKey) {
          setSelectedItemIds((prev) => new Set([...prev, ...rangeIds]));
        } else {
          setSelectedItemIds(rangeIds);
        }
        return;
      }
    }
    if (e.ctrlKey || e.metaKey) {
      setAnchorItemId(item.id);
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        next.has(item.id) ? next.delete(item.id) : next.add(item.id);
        return next;
      });
      return;
    }
    setAnchorItemId(item.id);
    if (selectedItemIds().size === 1 && selectedItemIds().has(item.id)) {
      setSelectedItemIds(new Set<string>());
    } else {
      setSelectedItemIds(new Set([item.id]));
    }
  };

  // Keyboard equivalents of the row gestures. The Menu key raises a native
  // contextmenu event, so handleItemContextMenu already covers that path.
  const handleItemKeyDown = (e: KeyboardEvent, item: Item) => {
    // Let a control inside the row keep its own keys.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter") {
      e.preventDefault();
      setEditingItem(item);
    } else if (e.key === " ") {
      e.preventDefault();
      setAnchorItemId(item.id);
      setSelectedItemIds((prev) => {
        const next = new Set(prev);
        next.has(item.id) ? next.delete(item.id) : next.add(item.id);
        return next;
      });
    }
  };

  const handleItemContextMenu = (e: MouseEvent, item: Item) => {
    e.preventDefault();
    e.stopPropagation();
    if (isTouch) {
      if ((e.target as Element).closest('.drag-handle')) return; // long-press on grip = drag, not edit
      lastContextMenuTime = Date.now();
      setSelectionMode(true);
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
      return;
    }
    if (!selectedItemIds().has(item.id)) {
      setSelectedItemIds(new Set([item.id]));
      setAnchorItemId(item.id);
    }
    setItemCtxMenu({ ...menuPosition(e), item });
  };

  const handleCrossListMove = async (itemId: string, toEl: HTMLElement, rawPredecessorId: string | null) => {
    const toListId = toEl.dataset.listId;
    if (!toListId || !itemId) return;

    const sourceItem = [...itemsByList().values()].flatMap((its) => its).find((i) => i.id === itemId);
    if (!sourceItem || sourceItem.list_id === toListId) return;

    const timestamp = Date.now();

    const toItems = itemsByList().get(toListId) ?? []; // chain order

    // Resolve dummy predecessor: use the dummy's real after_id instead.
    const predecessorId = rawPredecessorId === DUMMY_ITEM_ID
      ? resolvedDummyAfterId(toListId)
      : rawPredecessorId;

    // Splice fix-ups: the target item that followed the insertion point now
    // follows the moved item; the source item that followed the moved item skips
    // over it (inherits the moved item's old predecessor).
    const rawSource = await db.items.where("list_id").equals(sourceItem.list_id).toArray();
    const { sourceSuccessorUpdate, targetSuccessorUpdate } = computeCrossListMove(
      rawSource, toItems, itemId, sourceItem.after_id ?? null, predecessorId,
    );

    await db.transaction("rw", db.items, async () => {
      await db.items.update(itemId, { list_id: toListId, after_id: predecessorId, updated_at: timestamp });
      if (sourceSuccessorUpdate) {
        await db.items.update(sourceSuccessorUpdate.id, { after_id: sourceSuccessorUpdate.after_id, updated_at: timestamp });
      }
      if (targetSuccessorUpdate) {
        await db.items.update(targetSuccessorUpdate.id, { after_id: targetSuccessorUpdate.after_id, updated_at: timestamp });
      }
    });

    syncClient.pushEntity("item", { ...sourceItem, list_id: toListId, after_id: predecessorId, updated_at: timestamp });
    for (const update of [sourceSuccessorUpdate, targetSuccessorUpdate]) {
      if (!update) continue;
      const fresh = await db.items.get(update.id);
      if (fresh) syncClient.pushEntity("item", fresh);
    }
  };

  const totalItemCount = createMemo(() => {
    let count = 0;
    for (const list of visibleLists()) {
      count += itemsForList(list.id).length;
    }
    return count;
  });

  return (
    <div class="main">
      <Show when={board()} fallback={<div class="empty-state"><p>Board not found.</p></div>}>
        {(_cat) => (
          <>
            <Show when={selectionMode()} fallback={
              <>
                <div class="page-header">
                  <div class="page-title" onContextMenu={(e) => { e.preventDefault(); setBoardCtxMenu(menuPosition(e)); }}>
                    <h1>{headerTitle()}</h1>
                    <Show when={board()?.sync_key}>
                      <ShareIcon class="shared-icon shared-icon-lg" />
                      <span class="sr-only">shared</span>
                    </Show>
                    <span class="count">{totalItemCount()}<span class="sr-only"> items</span></span>
                    {/* The same menu right-click raises, reachable without a
                        pointer and discoverable on touch. */}
                    <button
                      class="btn-icon btn-icon-sm btn-icon-quiet"
                      type="button"
                      aria-label={`Actions for board ${headerTitle()}`}
                      aria-haspopup="menu"
                      onClick={(e) => setBoardCtxMenu(menuPosition(e))}
                    >
                      <span aria-hidden="true">⋯</span>
                    </button>
                  </div>
                  <div class="header-actions">
                    <input
                      class="filter-input"
                      type="text"
                      aria-label="Filter items"
                      placeholder="Filter..."
                      value={filterQuery()}
                      onInput={(e) => setFilterQuery(e.currentTarget.value)}
                    />
                    <button
                      class="header-toggle filter-toggle-btn"
                      classList={{ active: filterOpen() }}
                      onClick={() => setFilterOpen((v) => !v)}
                      aria-label="Filter"
                      aria-expanded={filterOpen()}
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v1.5a1.5 1.5 0 0 1-.44 1.06L10 9.62V14a1 1 0 0 1-1.45.9l-2-1A1 1 0 0 1 6 13v-3.38L1.44 5.06A1.5 1.5 0 0 1 1 4V2.5zm1.5-.5a.5.5 0 0 0-.5.5V4a.5.5 0 0 0 .15.35L7.5 9.2V13l1 .5V9.2l4.85-4.85A.5.5 0 0 0 13.5 4V2.5a.5.5 0 0 0-.5-.5h-11z"/></svg>
                    </button>
                    <div class="view-switcher" role="group" aria-label="View mode">
                      <For each={VIEW_MODES}>
                        {(vm) => (
                          <button
                            type="button"
                            aria-pressed={appViewMode() === vm.mode}
                            class="view-switcher-btn"
                            classList={{ active: appViewMode() === vm.mode }}
                            onClick={() => setAppViewMode(vm.mode)}
                          >
                            {vm.label}
                          </button>
                        )}
                      </For>
                    </div>
                    <button
                      class="header-toggle config-btn"
                      classList={{ active: configOpen() }}
                      onClick={() => setConfigOpen(true)}
                      aria-label="Display settings"
                      aria-haspopup="dialog"
                    >
                      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M11.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM9.05 3a2.5 2.5 0 0 1 4.9 0H16v1h-2.05a2.5 2.5 0 0 1-4.9 0H0V3h9.05zM4.5 7a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM2.05 8a2.5 2.5 0 0 1 4.9 0H16v1H6.95a2.5 2.5 0 0 1-4.9 0H0V8h2.05zm9.45 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm-2.45 1a2.5 2.5 0 0 1 4.9 0H16v1h-2.05a2.5 2.5 0 0 1-4.9 0H0v-1h9.05z"/></svg>
                    </button>
                  </div>
                </div>

                <Show when={filterOpen()}>
                  <div class="mobile-filter-bar">
                    <input
                      class="filter-input"
                      type="text"
                      aria-label="Filter items"
                      placeholder="Filter..."
                      value={filterQuery()}
                      onInput={(e) => setFilterQuery(e.currentTarget.value)}
                      ref={(el) => setTimeout(() => el.focus(), 50)}
                    />
                    <button
                      class="btn-icon"
                      onClick={() => { setFilterOpen(false); setFilterQuery(""); }}
                      aria-label="Close filter"
                    >
                      ✕
                    </button>
                  </div>
                </Show>
              </>
            }>
              <div class="selection-bar">
                <button class="btn-icon btn-icon-lg btn-icon-strong" onClick={exitSelectionMode} aria-label="Cancel selection">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M5 12H19M5 12L11 6M5 12L11 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>
                </button>
                <span class="selection-bar-count" role="status" aria-live="polite">{selectedItemIds().size} selected</span>
                <button class="btn-ghost" onClick={handleEditFromBar}>Edit</button>
                <button class="btn-ghost" onClick={() => setShowMoveToList(true)}>Move</button>
                <button class="btn-danger" onClick={handleDeleteSelectedItems}>Delete</button>
              </div>
            </Show>

            <div
              class="multi-list-view"
              classList={{ "multi-list-vertical": appViewMode() !== "list" }}
              ref={(el) => { multiListViewEl = el; observeBoardWidth(el); }}
              onMouseDown={handleBoardBackgroundDown}
            >
              <For each={visibleLists()}>
                {(list) => {
                  const items = createMemo(() => itemsForList(list.id));
                  const allItemsForList = () => itemsByList().get(list.id) ?? [];

                  // Display list for list-view: real items (filtered) with the dummy spliced in.
                  const displayItems = createMemo((): (Item | DummyShim)[] => {
                    const allForList = itemsByList().get(list.id) ?? [];
                    const dummyAfterId = resolvedDummyAfterId(list.id);

                    const insertIdx = dummyAfterId === null
                      ? 0
                      : (() => {
                          const idx = allForList.findIndex(i => i.id === dummyAfterId);
                          return idx === -1 ? allForList.length : idx + 1;
                        })();

                    const withDummy = (allForList as (Item | DummyShim)[]).toSpliced(insertIdx, 0, DUMMY_SHIM);

                    const q = filterQuery().toLowerCase().trim();
                    if (!q) return withDummy;
                    return withDummy.filter((item) => {
                      if (item.id === DUMMY_ITEM_ID) return true;
                      const it = item as Item;
                      return effectiveValues(it, overlays[it.id]).some((val) => val != null && String(val).toLowerCase().includes(q));
                    });
                  });

                  const applyOptimisticReorder = (updates: { id: string; after_id: string | null }[]) => {
                    const updatesMap = new Map(updates.map(u => [u.id, u.after_id]));
                    const newMap = new Map(itemsByList());
                    const listItems = newMap.get(list.id) ?? [];
                    newMap.set(list.id, resolveChain(
                      listItems.map(item =>
                        updatesMap.has(item.id) ? { ...item, after_id: updatesMap.get(item.id)! } : item
                      )
                    ));
                    setItemsByList(newMap);
                  };
                  return (
                    <div class="panel multi-list-column" data-list-id={list.id}>
                      <div
                        class="multi-list-column-header"
                        onContextMenu={(e) => { e.preventDefault(); setListCtxMenu({ ...menuPosition(e), list }); }}
                      >
                        <button
                          type="button"
                          class="btn-bare multi-list-column-select"
                          aria-pressed={selectedListIds().has(list.id)}
                          onClick={() => {
                            if (isTouch) {
                              const now = Date.now();
                              if (lastTapListId === list.id && now - lastTapListTime < 350) {
                                lastTapListId = null; lastTapListTime = 0;
                                setEditingList(list);
                                return;
                              }
                              lastTapListId = list.id; lastTapListTime = now;
                            }
                            setSelectedListIds(new Set([list.id]));
                          }}
                        >
                          <span class="multi-list-column-name">{list.name}</span>
                          <span class="count">{items().length}<span class="sr-only"> items</span></span>
                        </button>
                        <button
                          class="btn-icon btn-icon-quiet multi-list-add-btn"
                          type="button"
                          aria-label={`Add item to ${list.name}`}
                          onClick={() => setDummyAfterId(list.id, null) /* move inline-add dummy to top */}
                        >+</button>
                        <button
                          class="btn-icon btn-icon-sm btn-icon-quiet"
                          type="button"
                          aria-label={`Actions for list ${list.name}`}
                          aria-haspopup="menu"
                          onClick={(e) => setListCtxMenu({ ...menuPosition(e), list })}
                        >
                          <span aria-hidden="true">⋯</span>
                        </button>
                      </div>

                      <Switch>
                        <Match when={appViewMode() === "list"}>
                          <ul
                            class="list-view multi-list-items"
                            aria-label={`Items in ${list.name}`}
                            data-list-id={list.id}
                            ref={(el) => useSortable(el, allItemsForList, {
                              group: params.id,
                              onCrossMove: handleCrossListMove,
                              onOptimisticReorder: applyOptimisticReorder,
                              onDummyReorder: (newAfterId) => setDummyAfterId(list.id, newAfterId),
                              getDummyAfterId: () => resolvedDummyAfterId(list.id),
                              scrollEl: multiListViewEl,
                            })}
                          >
                            <For each={displayItems()}>
                              {(item) => {
                                if (item.id === DUMMY_ITEM_ID) {
                                  return (
                                    <InlineAddItem
                                      onAdd={async (title) => {
                                        const afterId = resolvedDummyAfterId(list.id);
                                        const newItem = await createItem(list.id, title, {}, afterId);
                                        resetDummyAfterId(list.id);
                                      }}
                                      onExpand={(title) => {
                                        setAddingInitialTitle(title);
                                        setAddingToList(list.id);
                                      }}
                                    />
                                  );
                                }
                                const realItem = item as Item;
                                return (
                                  <li
                                    class="list-view-item"
                                    data-item-id={realItem.id}
                                    tabindex={0}
                                    classList={{
                                      selected: selectedItemIds().has(realItem.id),
                                      "todo-done": todoAttr() !== undefined && getTodoState(realItem) === "done",
                                      "todo-cancelled": todoAttr() !== undefined && getTodoState(realItem) === "cancelled",
                                      "todo-skipped": todoAttr() !== undefined && getTodoState(realItem) === "skipped",
                                    }}
                                    onTouchStart={(e) => handleItemTouchStart(e, realItem)}
                                    onTouchMove={handleItemTouchMove}
                                    onClick={(e) => handleItemClick(e, realItem, items())}
                                    onDblClick={() => setEditingItem(realItem)}
                                    onKeyDown={(e) => handleItemKeyDown(e, realItem)}
                                    onContextMenu={(e) => handleItemContextMenu(e, realItem)}
                                  >
                                    <Show when={selectedItemIds().has(realItem.id)}>
                                      <span class="sr-only">Selected. </span>
                                    </Show>
                                    <Show when={selectionMode()} fallback={<span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>}>
                                      {/* Display only: the row itself carries the toggle. */}
                                      <input type="checkbox" class="item-select-checkbox" tabindex={-1} aria-hidden="true" checked={selectedItemIds().has(realItem.id)} />
                                    </Show>
                                    <ItemText item={realItem} list={list} />
                                    {integrationBadge(realItem.id)}
                                    <Show when={todoAttr()}>
                                      {(attr) => (
                                        <button
                                          type="button"
                                          class={`btn-bare todo-control todo-${getTodoState(realItem)}`}
                                          onClick={async (e) => {
                                            e.stopPropagation();
                                            const cur = getTodoState(realItem);
                                            await updateItemAttribute(realItem.id, attr().key, cur === "default" ? "done" : undefined);
                                          }}
                                          onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setTodoCtxMenu({ x: e.clientX, y: e.clientY, item: realItem, attrKey: attr().key });
                                          }}
                                          onTouchStart={(e) => {
                                            e.stopPropagation();
                                            todoLongPressTimer = setTimeout(() => {
                                              todoLongPressTimer = null;
                                              setTodoCtxMenu({ x: e.touches[0].clientX, y: e.touches[0].clientY, item: realItem, attrKey: attr().key });
                                            }, 500);
                                          }}
                                          onTouchEnd={async (e) => {
                                            if (todoLongPressTimer !== null) {
                                              clearTimeout(todoLongPressTimer);
                                              todoLongPressTimer = null;
                                              e.preventDefault();
                                              const cur = getTodoState(realItem);
                                              await updateItemAttribute(realItem.id, attr().key, cur === "default" ? "done" : undefined);
                                            }
                                          }}
                                          onTouchMove={() => {
                                            if (todoLongPressTimer !== null) {
                                              clearTimeout(todoLongPressTimer);
                                              todoLongPressTimer = null;
                                            }
                                          }}
                                          aria-label={`${realItem.title}: ${TODO_LABELS[getTodoState(realItem)]}. Activate to toggle done.`}
                                          aria-haspopup="menu"
                                        >
                                          <TodoIcon state={getTodoState(realItem)} />
                                        </button>
                                      )}
                                    </Show>
                                  </li>
                                );
                              }}
                            </For>
                          </ul>
                        </Match>

                        <Match when={appViewMode() === "table"}>
                          <div class="table-container">
                            <table>
                              <thead>
                                <tr>
                                  <th class="drag-handle-cell"><span class="sr-only">Reorder</span></th>
                                  <th>Title</th>
                                  <For each={schema()}>
                                    {(attr) => <th>{attr.label || attr.key}</th>}
                                  </For>
                                </tr>
                              </thead>
                              <tbody data-list-id={list.id} ref={(el) => useSortable(el, allItemsForList, {
                                group: params.id,
                                onCrossMove: handleCrossListMove,
                                onOptimisticReorder: applyOptimisticReorder,
                                onDummyReorder: (newAfterId) => setDummyAfterId(list.id, newAfterId),
                                getDummyAfterId: () => resolvedDummyAfterId(list.id),
                                scrollEl: multiListViewEl,
                              })}>
                                <For each={displayItems()}>
                                  {(item) => {
                                    if (item.id === DUMMY_ITEM_ID) {
                                      return (
                                        <InlineAddItem
                                          variant="table"
                                          colspan={schema().length + 1}
                                          onAdd={async (title) => {
                                            const afterId = resolvedDummyAfterId(list.id);
                                            const newItem = await createItem(list.id, title, {}, afterId);
                                            resetDummyAfterId(list.id);
                                          }}
                                          onExpand={(title) => {
                                            setAddingInitialTitle(title);
                                            setAddingToList(list.id);
                                          }}
                                        />
                                      );
                                    }
                                    const item_ = item as Item;
                                    return (
                                      <tr
                                        data-item-id={item_.id}
                                        tabindex={0}
                                        classList={{ selected: selectedItemIds().has(item_.id) }}
                                        onTouchStart={(e) => handleItemTouchStart(e, item_)}
                                        onTouchMove={handleItemTouchMove}
                                        onClick={(e) => handleItemClick(e, item_, items())}
                                        onDblClick={() => setEditingItem(item_)}
                                        onKeyDown={(e) => handleItemKeyDown(e, item_)}
                                        onContextMenu={(e) => handleItemContextMenu(e, item_)}
                                      >
                                        <td class="drag-handle-cell">
                                          <Show when={selectionMode()} fallback={<span class="drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>}>
                                            <input type="checkbox" class="item-select-checkbox" tabindex={-1} aria-hidden="true" checked={selectedItemIds().has(item_.id)} />
                                          </Show>
                                        </td>
                                        <td class="cell-title">
                                          <Show when={selectedItemIds().has(item_.id)}>
                                            <span class="sr-only">Selected. </span>
                                          </Show>
                                          {String(effectiveValue(item_, "title", overlays[item_.id]) ?? "")}{integrationBadge(item_.id)}
                                        </td>
                                        <For each={schema()}>
                                          {(attr) => (
                                            <td>{formatCellValue(effectiveValue(item_, attr.key, overlays[item_.id]), attr.type)}</td>
                                          )}
                                        </For>
                                      </tr>
                                    );
                                  }}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </Match>

                        <Match when={appViewMode() === "card"}>
                          <div class="card-container">
                            <div class="card-grid" role="list" aria-label={`Items in ${list.name}`} data-list-id={list.id} ref={(el) => useSortable(el, allItemsForList, {
                              group: params.id,
                              onCrossMove: handleCrossListMove,
                              onOptimisticReorder: applyOptimisticReorder,
                              onDummyReorder: (newAfterId) => setDummyAfterId(list.id, newAfterId),
                              getDummyAfterId: () => resolvedDummyAfterId(list.id),
                              scrollEl: multiListViewEl,
                            })}>
                              <For each={displayItems()}>
                                {(item) => {
                                  if (item.id === DUMMY_ITEM_ID) {
                                    return (
                                      <InlineAddItem
                                        variant="card"
                                        onAdd={async (title) => {
                                          const afterId = resolvedDummyAfterId(list.id);
                                          const newItem = await createItem(list.id, title, {}, afterId);
                                          resetDummyAfterId(list.id);
                                        }}
                                        onExpand={(title) => {
                                          setAddingInitialTitle(title);
                                          setAddingToList(list.id);
                                        }}
                                      />
                                    );
                                  }
                                  const item_ = item as Item;
                                  return (
                                    <div
                                      class="panel card item"
                                      data-item-id={item_.id}
                                      role="listitem"
                                      tabindex={0}
                                      classList={{ selected: selectedItemIds().has(item_.id) }}
                                      onTouchStart={(e) => handleItemTouchStart(e, item_)}
                                      onTouchMove={handleItemTouchMove}
                                      onClick={(e) => handleItemClick(e, item_, items())}
                                      onDblClick={() => setEditingItem(item_)}
                                      onKeyDown={(e) => handleItemKeyDown(e, item_)}
                                      onContextMenu={(e) => handleItemContextMenu(e, item_)}
                                    >
                                      <Show when={selectedItemIds().has(item_.id)}>
                                        <span class="sr-only">Selected. </span>
                                      </Show>
                                      <Show when={selectionMode()} fallback={<span class="drag-handle card-drag-handle" aria-hidden="true" title="Drag to reorder">⠿</span>}>
                                        <input type="checkbox" class="card-select-checkbox" tabindex={-1} aria-hidden="true" checked={selectedItemIds().has(item_.id)} />
                                      </Show>
                                      <div class="card-title"><ItemText item={item_} list={list} />{integrationBadge(item_.id)}</div>
                                      <Show when={schema().length > 0}>
                                        <div class="card-attrs">
                                          <For each={schema()}>
                                            {(attr) => {
                                              const val = effectiveValue(item_, attr.key, overlays[item_.id]);
                                              if (val == null || val === "") return null;
                                              return (
                                                <div class="card-attr">
                                                  <span class="card-attr-label">{attr.label || attr.key}</span>
                                                  <Show
                                                    when={attr.type === "tags" && Array.isArray(val)}
                                                    fallback={<span>{formatCellValue(val, attr.type)}</span>}
                                                  >
                                                    <span>
                                                      <For each={val as string[]}>
                                                        {(t) => <span class="tag">{t}</span>}
                                                      </For>
                                                    </span>
                                                  </Show>
                                                </div>
                                              );
                                            }}
                                          </For>
                                        </div>
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </div>
                        </Match>
                      </Switch>
                    </div>
                  );
                }}
              </For>
              <button type="button" class="btn-bare panel multi-list-new-column" onClick={handleNewList}>
                + New list
              </button>
            </div>

            <Show when={boardCtxMenu() !== null}>
              {(_) => {
                const pos = () => boardCtxMenu()!;
                return (
                  <ContextMenu x={pos().x} y={pos().y} label={`Actions for board ${headerTitle()}`} items={boardCtxMenuItems()} onClose={() => setBoardCtxMenu(null)} />
                );
              }}
            </Show>

            <Show when={boardImportScope()}>
              {(scope) => <ImportModal open={true} onClose={() => setBoardImportScope(null)} scope={scope()} />}
            </Show>

            <CloneBoardModal board={cloningBoard()} onClose={() => setCloningBoard(undefined)} />

            <BoardShareModal
              open={sharingBoard() !== undefined}
              onClose={() => setSharingBoard(undefined)}
              board={sharingBoard()}
            />

            <Show when={listCtxMenu() !== null}>
              {(_) => {
                const pos = () => listCtxMenu()!;
                return (
                  <ContextMenu x={pos().x} y={pos().y} label={`Actions for list ${pos().list.name}`} items={listCtxMenuItems()} onClose={() => setListCtxMenu(null)} />
                );
              }}
            </Show>

            <Show when={listImportScope()}>
              {(scope) => <ImportModal open={true} onClose={() => setListImportScope(null)} scope={scope()} />}
            </Show>

            <Show when={itemCtxMenu() !== null}>
              {(_) => {
                const pos = () => itemCtxMenu()!;
                return (
                  <ContextMenu
                    x={pos().x}
                    y={pos().y}
                    label={`Actions for ${pos().item.title}`}
                    items={itemCtxMenuItems()}
                    onClose={() => setItemCtxMenu(null)}
                  />
                );
              }}
            </Show>

            <Show when={todoCtxMenu() !== null}>
              {(_) => {
                const pos = () => todoCtxMenu()!;
                return (
                  <ContextMenu
                    x={pos().x}
                    y={pos().y}
                    label={`Set state for ${pos().item.title}`}
                    items={todoCtxMenuItems()}
                    onClose={() => setTodoCtxMenu(null)}
                  />
                );
              }}
            </Show>

            <ItemFormModal
              open={addingToList() !== null}
              onClose={() => { setAddingToList(null); setAddingInitialTitle(""); }}
              onSave={handleAddItem}
              schema={schema()}
              initialTitle={addingInitialTitle()}
            />

            <MultiItemFormModal
              open={showMultiEdit()}
              onClose={() => setShowMultiEdit(false)}
              onSave={handleMultiEditSave}
              schema={schema()}
              count={selectedItemIds().size}
            />

            <ItemFormModal
              open={editingItem() !== undefined}
              onClose={() => setEditingItem(undefined)}
              onSave={handleEditItem}
              onDelete={handleDeleteItem}
              schema={schema()}
              initial={editingItem()}
              overlay={editingItem() ? overlays[editingItem()!.id] : undefined}
              overlaySources={editingSources()}
            />

            <IntegrationChoiceModal
              item={pickingItem()}
              current={pickingItem() ? overlays[pickingItem()!.id] : undefined}
              results={pickingItem() ? orderResults(resultsByItemId().get(pickingItem()!.id) ?? [], board()?.integrations) : []}
              onClose={() => setPickingItemId(null)}
              onPick={handlePick}
            />

            <ListFormModal
              open={editingList() !== undefined}
              onClose={() => setEditingList(undefined)}
              onSave={handleEditList}
              boards={allBoards() ?? []}
              initial={editingList()}
            />

            <BoardFormModal
              open={editingBoard() !== undefined}
              onClose={() => setEditingBoard(undefined)}
              onSave={handleEditBoard}
              initial={editingBoard()}
            />

            <MoveToListModal
              open={showMoveToList()}
              onClose={() => setShowMoveToList(false)}
              onSelect={handleMoveToList}
              currentBoardId={board()?.id}
            />

            <Show when={configOpen()}>
              <div class="overlay overlay-bottom" onClick={() => setConfigOpen(false)}>
                <div
                  class="panel config-sheet"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="config-sheet-title"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => { if (e.key === "Escape") setConfigOpen(false); }}
                >
                  <div class="config-sheet-header">
                    <span class="config-sheet-title" id="config-sheet-title">Display</span>
                    <button
                      class="btn-icon"
                      onClick={() => setConfigOpen(false)}
                      aria-label="Close display settings"
                      ref={(el) => setTimeout(() => el.focus(), 0)}
                    >
                      <span aria-hidden="true">✕</span>
                    </button>
                  </div>
                  <div class="config-section" role="group" aria-labelledby="config-view-label">
                    <div class="config-section-label" id="config-view-label">View</div>
                    <For each={VIEW_MODES}>
                      {(vm) => (
                        <button
                          class="config-option"
                          aria-pressed={appViewMode() === vm.mode}
                          classList={{ active: appViewMode() === vm.mode }}
                          onClick={() => { setAppViewMode(vm.mode); setConfigOpen(false); }}
                        >
                          <span class="config-option-label">{vm.label}</span>
                          <Show when={appViewMode() === vm.mode}>
                            <span class="config-option-check" aria-hidden="true">✓</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                  <div class="config-section config-section-divided" role="group" aria-labelledby="config-theme-label">
                    <div class="config-section-label" id="config-theme-label">Appearance</div>
                    <For each={THEME_OPTIONS}>
                      {(opt) => (
                        <button
                          class="config-option"
                          aria-pressed={themePref() === opt.value}
                          classList={{ active: themePref() === opt.value }}
                          onClick={() => setThemePref(opt.value)}
                        >
                          <span class="config-option-label">{opt.label}</span>
                          <Show when={themePref() === opt.value}>
                            <span class="config-option-check" aria-hidden="true">✓</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default ListView;
