import Sortable from "sortablejs";
import { onCleanup } from "solid-js";
import { db } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { computeReorder } from "./reorderLogic.js";

export { computeReorder };

export function useSortable(
  el: HTMLElement,
  getItems: () => { id: string; position: number }[],
  options?: Partial<Sortable.Options> & {
    indexOffset?: number;
    onCrossMove?: (itemId: string, toEl: HTMLElement, rawNewIndex: number) => Promise<void>;
    scrollEl?: HTMLElement;
  },
) {
  const { indexOffset = 0, onCrossMove, scrollEl, ...sortableOptions } = options ?? {};

  // Edge-scroll state
  let dragX = 0;
  let dragY = 0;
  let dragStartX = 0;
  let scrollUnlocked = false;
  let lastSnapTime = 0;
  let scrollRaf: number | null = null;

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
  };

  const startEdgeScroll = (initialX: number, initialY: number) => {
    if (scrollEl) scrollEl.style.scrollSnapType = "none";
    dragX = initialX;
    dragY = initialY;
    dragStartX = initialX;
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
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".view-add, .card.add",
    ...sortableOptions,
    onStart: (evt) => {
      navigator.vibrate?.(50);
      const oe = (evt as any).originalEvent as Event | undefined;
      const x = isTouchEvent(oe) ? (oe.touches[0]?.clientX ?? 0) : (oe as MouseEvent)?.clientX ?? 0;
      const y = isTouchEvent(oe) ? (oe.touches[0]?.clientY ?? 0) : (oe as MouseEvent)?.clientY ?? 0;
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
