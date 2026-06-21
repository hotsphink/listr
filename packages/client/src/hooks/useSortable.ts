import Sortable from "sortablejs";
import { onCleanup } from "solid-js";
import { db } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { computeReorder } from "./reorderLogic.js";

export { computeReorder };

export function useSortable(
  el: HTMLElement,
  getItems: () => { id: string }[],
  options?: Partial<Sortable.Options> & {
    indexOffset?: number;
    onCrossMove?: (itemId: string, toEl: HTMLElement, rawNewIndex: number) => Promise<void>;
    scrollEl?: HTMLElement;
  },
) {
  const { indexOffset = 0, onCrossMove, scrollEl, ...sortableOptions } = options ?? {};

  // Edge-scroll state
  let dragX = 0;
  let dragStartX = 0;
  let scrollUnlocked = false;
  let lastSnapTime = 0;
  let scrollRaf: number | null = null;

  const updateDragX = (e: Event) => {
    if (e instanceof TouchEvent) dragX = e.touches[0]?.clientX ?? dragX;
    else if (e instanceof MouseEvent) dragX = e.clientX;
  };

  const stopEdgeScroll = () => {
    if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
    document.removeEventListener("pointermove", updateDragX);
    document.removeEventListener("touchmove", updateDragX);
    if (scrollEl) scrollEl.style.scrollSnapType = "";
  };

  const startEdgeScroll = (initialX: number) => {
    if (!scrollEl) return;
    scrollEl.style.scrollSnapType = "none";
    dragX = initialX;
    dragStartX = initialX;
    scrollUnlocked = false;
    lastSnapTime = 0;
    document.addEventListener("pointermove", updateDragX, { passive: true });
    document.addEventListener("touchmove", updateDragX, { passive: true });

    const SENSITIVITY = 80;
    const UNLOCK_THRESHOLD = 40; // px horizontal movement before edge-scroll activates
    const SNAP_COOLDOWN = 350;   // ms between column snaps

    const tick = () => {
      if (!scrollUnlocked) {
        if (Math.abs(dragX - dragStartX) > UNLOCK_THRESHOLD) scrollUnlocked = true;
      }

      if (scrollUnlocked) {
        const rect = scrollEl.getBoundingClientRect();
        const now = Date.now();
        if (now - lastSnapTime > SNAP_COOLDOWN) {
          const columns = Array.from(scrollEl.children) as HTMLElement[];
          const curIdx = columns.reduce(
            (best, col, i) => (col.offsetLeft <= scrollEl.scrollLeft + 1 ? i : best), 0
          );

          // Map drag position from viewport coords into scroll-space, then find which
          // column it falls over. If it's a different column than the current snap
          // position, scroll there — this handles partially-visible adjacent columns.
          const dragXInScroll = dragX - rect.left + scrollEl.scrollLeft;
          const overIdx = columns.findIndex((col) =>
            dragXInScroll >= col.offsetLeft && dragXInScroll < col.offsetLeft + col.offsetWidth
          );

          if (overIdx !== -1 && overIdx !== curIdx) {
            scrollEl.scrollTo({ left: columns[overIdx].offsetLeft, behavior: "smooth" });
            lastSnapTime = now;
          } else if (rect.right - dragX < SENSITIVITY && curIdx < columns.length - 1) {
            scrollEl.scrollTo({ left: columns[curIdx + 1].offsetLeft, behavior: "smooth" });
            lastSnapTime = now;
          } else if (dragX - rect.left < SENSITIVITY && curIdx > 0) {
            scrollEl.scrollTo({ left: columns[curIdx - 1].offsetLeft, behavior: "smooth" });
            lastSnapTime = now;
          }
        }
      }

      scrollRaf = requestAnimationFrame(tick);
    };
    scrollRaf = requestAnimationFrame(tick);
  };

  const sortable = Sortable.create(el, {
    animation: 150,
    delay: 300,
    delayOnTouchOnly: true,
    handle: ".drag-handle",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".view-add, .card.add",
    ...sortableOptions,
    onStart: (evt) => {
      navigator.vibrate?.(50);
      const oe = (evt as any).originalEvent as Event | undefined;
      const x = oe instanceof TouchEvent ? (oe.touches[0]?.clientX ?? 0) : (oe as MouseEvent)?.clientX ?? 0;
      startEdgeScroll(x);
    },
    onMove: (evt, originalEvent) => {
      updateDragX(originalEvent);
      if (evt.related?.classList.contains("view-add") ||
          evt.related?.classList.contains("add")) {
        return false;
      }
      return true;
    },
    onEnd: async (evt) => {
      stopEdgeScroll();

      const rawOld = evt.oldIndex;
      const rawNew = evt.newIndex;
      if (rawOld == null || rawNew == null) return;

      // Cross-list drag
      if (evt.from !== evt.to) {
        const itemEl = evt.item as HTMLElement;
        if (evt.to.contains(itemEl)) evt.to.removeChild(itemEl);
        if (rawOld < evt.from.children.length) {
          evt.from.insertBefore(itemEl, evt.from.children[rawOld]);
        } else {
          evt.from.appendChild(itemEl);
        }
        if (!onCrossMove) return;
        const itemId = itemEl.dataset.itemId ?? "";
        if (itemId) await onCrossMove(itemId, evt.to, rawNew);
        return;
      }

      if (rawOld === rawNew) return;

      const oldIndex = rawOld - indexOffset;
      const newIndex = rawNew - indexOffset;
      if (oldIndex < 0 || newIndex < 0) return;

      const currentItems = getItems();
      if (oldIndex >= currentItems.length || newIndex >= currentItems.length) return;

      // Revert the DOM move — SolidJS re-renders from reactive state
      const { item, from: container } = evt;
      if (rawOld < rawNew) {
        container.insertBefore(item, container.children[rawOld]);
      } else {
        container.insertBefore(item, container.children[rawOld + 1]);
      }

      const updates = computeReorder(currentItems, oldIndex, newIndex);
      const timestamp = Date.now();

      await db.transaction("rw", db.items, async () => {
        for (const { id, position } of updates) {
          await db.items.update(id, { position, updated_at: timestamp });
        }
      });

      // Push updated items to sync. Build from currentItems to avoid extra reads.
      const byId = new Map((currentItems as any[]).map((it) => [it.id, it]));
      for (const { id, position } of updates) {
        const base = byId.get(id);
        if (base) syncClient.pushEntity("item", { ...base, position, updated_at: timestamp });
      }
    },
  });

  onCleanup(() => { stopEdgeScroll(); sortable.destroy(); });
}
