import Sortable from "sortablejs";
import { createSignal, onCleanup } from "solid-js";
import { db } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { reorderByAfterId } from "./reorderLogic.js";

export const [isDragging, setIsDragging] = createSignal(false);
const CANCEL_ZONE_HEIGHT = 100; // px from top of viewport (larger than visual zone for finger margin)

export { reorderByAfterId };

export function useSortable(
  el: HTMLElement,
  getItems: () => { id: string; after_id: string | null }[],
  options?: Partial<Sortable.Options> & {
    onCrossMove?: (itemId: string, toEl: HTMLElement, rawNewIndex: number) => Promise<void>;
    onOptimisticReorder?: (updates: { id: string; after_id: string | null }[]) => void;
    scrollEl?: HTMLElement;
  },
) {
  const { onCrossMove, onOptimisticReorder, scrollEl, ...sortableOptions } = options ?? {};

  // Edge-scroll state
  let dragX = 0;
  let dragY = 0;
  let dragStartX = 0;
  let scrollUnlocked = false;
  let lastSnapTime = 0;
  let scrollRaf: number | null = null;
  let dragIsTouch = false;
  let startScrollLeft = 0;

  // Firefox desktop leaves TouchEvent undefined when touch events are disabled,
  // so referencing it in `instanceof` throws a ReferenceError. Guard on typeof.
  const isTouchEvent = (e: unknown): e is TouchEvent =>
    typeof TouchEvent !== "undefined" && e instanceof TouchEvent;

  const updateDrag = (e: Event) => {
    if (isTouchEvent(e)) {
      dragX = e.touches[0]?.clientX ?? dragX;
      dragY = e.touches[0]?.clientY ?? dragY;
    } else if (e instanceof MouseEvent) {
      dragX = e.clientX;
      dragY = e.clientY;
    }
  };

  const stopEdgeScroll = () => {
    if (scrollRaf !== null) { cancelAnimationFrame(scrollRaf); scrollRaf = null; }
    document.removeEventListener("pointermove", updateDrag);
    document.removeEventListener("touchmove", updateDrag);
    if (scrollEl) scrollEl.style.scrollSnapType = "";
    document.getElementById("drag-cancel-zone")?.classList.remove("over");
  };

  const startEdgeScroll = (initialX: number, initialY: number) => {
    if (scrollEl) scrollEl.style.scrollSnapType = "none";
    dragX = initialX;
    dragY = initialY;
    dragStartX = initialX;
    startScrollLeft = scrollEl?.scrollLeft ?? 0;
    scrollUnlocked = false;
    lastSnapTime = 0;
    document.addEventListener("pointermove", updateDrag, { passive: true });
    document.addEventListener("touchmove", updateDrag, { passive: true });

    const SENSITIVITY = 80;
    const UNLOCK_THRESHOLD = 40; // px horizontal movement before edge-scroll activates
    const SNAP_COOLDOWN = 350;   // ms between column snaps
    const VERT_ZONE = 80;        // px from top/bottom edge that triggers vertical scroll
    const VERT_SPEED = 6;        // px per frame

    const applyVerticalScroll = (vertEl: HTMLElement) => {
      const vr = vertEl.getBoundingClientRect();
      const fromTop = dragY - vr.top;
      const fromBottom = vr.bottom - dragY;
      if (fromTop < VERT_ZONE && vertEl.scrollTop > 0) {
        const speed = Math.ceil(VERT_SPEED * (1 - fromTop / VERT_ZONE));
        vertEl.scrollTop = Math.max(0, vertEl.scrollTop - speed);
      } else if (fromBottom < VERT_ZONE) {
        const maxScroll = vertEl.scrollHeight - vertEl.clientHeight;
        if (vertEl.scrollTop < maxScroll) {
          const speed = Math.ceil(VERT_SPEED * (1 - fromBottom / VERT_ZONE));
          vertEl.scrollTop = Math.min(maxScroll, vertEl.scrollTop + speed);
        }
      }
    };

    const tick = () => {
      document.getElementById("drag-cancel-zone")?.classList
        .toggle("over", dragY < CANCEL_ZONE_HEIGHT);

      if (!scrollUnlocked) {
        if (Math.abs(dragX - dragStartX) > UNLOCK_THRESHOLD) scrollUnlocked = true;
      }

      if (scrollEl) {
        // Multi-column layout: find the scrollable items container inside the
        // column currently under the drag position (handles cross-list drags).
        const columns = Array.from(scrollEl.children) as HTMLElement[];
        const hoveredCol = columns.find((col) => {
          const r = col.getBoundingClientRect();
          return dragX >= r.left && dragX < r.right;
        });
        if (hoveredCol) {
          const vertEl = Array.from(hoveredCol.children).find((c) => {
            const oy = getComputedStyle(c).overflowY;
            return oy === "auto" || oy === "scroll" || oy === "overlay";
          }) as HTMLElement | undefined;
          if (vertEl) applyVerticalScroll(vertEl);
        }

        if (scrollUnlocked) {
          const rect = scrollEl.getBoundingClientRect();
          const now = Date.now();
          if (now - lastSnapTime > SNAP_COOLDOWN) {
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
      } else {
        // Single-list context: scroll el itself vertically.
        applyVerticalScroll(el);
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
    // "Physical" drag feel: use the fallback (JS-driven clone) instead of native
    // HTML5 DnD. The original item leaves a plain gap (see .sortable-ghost) and a
    // real-size clone floats above the columns following the pointer.
    forceFallback: true,
    fallbackOnBody: true,
    fallbackClass: "sortable-fallback",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".view-add, .card.add",
    ...sortableOptions,
    onChoose: (evt) => {
      dragIsTouch = 'ontouchstart' in window;
      setIsDragging(true);
      (evt.item as HTMLElement).classList.add("drag-choosing");
    },
    onUnchoose: (evt) => {
      setIsDragging(false);
      (evt.item as HTMLElement).classList.remove("drag-choosing");
    },
    onStart: (evt) => {
      (evt.item as HTMLElement).classList.remove("drag-choosing");
      navigator.vibrate?.(50);
      const oe = (evt as any).originalEvent as Event | undefined;
      const touch = isTouchEvent(oe);
      dragIsTouch = touch || 'ontouchstart' in window;
      const x = touch ? (oe as TouchEvent).touches[0]?.clientX ?? 0 : (oe as MouseEvent)?.clientX ?? 0;
      const y = touch ? (oe as TouchEvent).touches[0]?.clientY ?? 0 : (oe as MouseEvent)?.clientY ?? 0;
      startEdgeScroll(x, y);
    },
    onMove: (evt, originalEvent) => {
      updateDrag(originalEvent);
      if (evt.related?.classList.contains("view-add") ||
          evt.related?.classList.contains("add")) {
        return false;
      }
      return true;
    },
    onEnd: async (evt) => {
      stopEdgeScroll();
      setIsDragging(false);
      const cancelled = dragIsTouch && dragY < CANCEL_ZONE_HEIGHT;

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
        if (cancelled) { scrollEl?.scrollTo({ left: startScrollLeft, behavior: "instant" }); return; }
        if (!onCrossMove) return;
        const itemId = itemEl.dataset.itemId ?? "";
        if (itemId) await onCrossMove(itemId, evt.to, rawNew);
        return;
      }

      if (rawOld === rawNew) return;

      // Read the predecessor from the DOM *before* reverting.
      const container = evt.from;
      const predecessorEl = rawNew > 0 ? container.children[rawNew - 1] as HTMLElement : null;
      const newAfterId = predecessorEl?.dataset.itemId ?? null;

      // Revert the DOM move — SolidJS re-renders from reactive state.
      const { item, from: c } = evt;
      if (rawOld < rawNew) {
        c.insertBefore(item, c.children[rawOld]);
      } else {
        c.insertBefore(item, c.children[rawOld + 1]);
      }

      if (cancelled) { scrollEl?.scrollTo({ left: startScrollLeft, behavior: "instant" }); return; }

      const movedId = (evt.item as HTMLElement).dataset.itemId ?? "";
      if (!movedId) return;

      const currentItems = getItems();
      const updates = reorderByAfterId(currentItems, movedId, newAfterId);
      if (!updates.length) return;

      onOptimisticReorder?.(updates);

      const timestamp = Date.now();

      await db.transaction("rw", db.items, async () => {
        for (const { id, after_id } of updates) {
          await db.items.update(id, { after_id, updated_at: timestamp });
        }
      });

      // Push updated items to sync. Build from currentItems to avoid extra reads.
      const byId = new Map(currentItems.map((it) => [it.id, it]));
      for (const { id, after_id } of updates) {
        const base = byId.get(id);
        if (base) syncClient.pushEntity("item", { ...base, after_id, updated_at: timestamp });
      }
    },
  });

  onCleanup(() => { stopEdgeScroll(); sortable.destroy(); });
}
