import Sortable from "sortablejs";
import { onCleanup } from "solid-js";
import { db } from "../db/database.js";

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

      const { item, from: container } = evt;
      if (evt.oldIndex! < evt.newIndex!) {
        const ref = container.children[evt.oldIndex!];
        container.insertBefore(item, ref);
      } else {
        const ref = container.children[evt.oldIndex! + 1];
        container.insertBefore(item, ref);
      }

      const reordered = [...currentItems];
      const [moved] = reordered.splice(oldIndex, 1);
      reordered.splice(newIndex, 0, moved);

      await db.transaction("rw", db.items, async () => {
        for (let i = 0; i < reordered.length; i++) {
          await db.items.update(reordered[i].id, { position: i });
        }
      });
    },
  });

  onCleanup(() => sortable.destroy());
}
