const POSITION_STEP = 64;

/**
 * Computes new positions after a drag-reorder. Returns only the items whose
 * position changes — ideally just the moved item, using the mean of its new
 * neighbors. Falls back to full renumbering (step POSITION_STEP) when the
 * insertion point has no gap to fit into.
 */
export function computeReorder(
  items: { id: string; position: number }[],
  oldIndex: number,
  newIndex: number,
): { id: string; position: number }[] {
  if (oldIndex === newIndex) return [];

  const reordered = [...items];
  const [moved] = reordered.splice(oldIndex, 1);
  reordered.splice(newIndex, 0, moved);

  const prev = newIndex > 0 ? reordered[newIndex - 1] : undefined;
  const next = newIndex < reordered.length - 1 ? reordered[newIndex + 1] : undefined;

  let targetPos: number;
  if (prev && next) {
    targetPos = Math.round((prev.position + next.position) / 2);
  } else if (prev) {
    targetPos = prev.position + POSITION_STEP;
  } else if (next) {
    targetPos = next.position - POSITION_STEP;
  } else {
    return [];
  }

  const hasCollision = reordered.some((item, i) => i !== newIndex && item.position === targetPos);
  if (!hasCollision) {
    return [{ id: moved.id, position: targetPos }];
  }

  return reordered.map((item, i) => ({ id: item.id, position: i * POSITION_STEP }));
}
