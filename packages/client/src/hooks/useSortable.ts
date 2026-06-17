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
  },
) {
  const { indexOffset = 0, onCrossMove, ...sortableOptions } = options ?? {};

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
    onMove: (evt) => {
      if (evt.related?.classList.contains("view-add") ||
          evt.related?.classList.contains("add")) {
        return false;
      }
      return true;
    },
    onEnd: async (evt) => {
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

  onCleanup(() => sortable.destroy());
}
