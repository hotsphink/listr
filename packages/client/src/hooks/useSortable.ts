import Sortable from "sortablejs";
import { onCleanup } from "solid-js";
import { db } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { computeReorder } from "./reorderLogic.js";

export { computeReorder };

export function useSortable(
  el: HTMLElement,
  getItems: () => { id: string }[],
  options?: Partial<Sortable.Options>,
) {
  const sortable = Sortable.create(el, {
    animation: 150,
    handle: ".drag-handle",
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    filter: ".list-view-add, .table-add, .add-card",
    ...options,
    onMove: (evt) => {
      if (evt.related?.classList.contains("list-view-add") ||
          evt.related?.classList.contains("table-add") ||
          evt.related?.classList.contains("add-card")) {
        return false;
      }
      return true;
    },
    onEnd: async (evt) => {
      const { oldIndex, newIndex } = evt;
      if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;

      const currentItems = getItems();
      if (oldIndex >= currentItems.length || newIndex >= currentItems.length) return;

      // Revert the DOM move — SolidJS re-renders from reactive state
      const { item, from: container } = evt;
      if (evt.oldIndex! < evt.newIndex!) {
        container.insertBefore(item, container.children[evt.oldIndex!]);
      } else {
        container.insertBefore(item, container.children[evt.oldIndex! + 1]);
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
