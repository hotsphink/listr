/**
 * Computes new positions after a drag-reorder. Returns items in their new
 * order with contiguous 0-based positions.
 */
export function computeReorder(
  items: { id: string }[],
  oldIndex: number,
  newIndex: number,
): { id: string; position: number }[] {
  const reordered = [...items];
  const [moved] = reordered.splice(oldIndex, 1);
  reordered.splice(newIndex, 0, moved);
  return reordered.map((item, i) => ({ id: item.id, position: i }));
}
