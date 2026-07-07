// One-time migration from legacy numeric `position` ordering to `after_id`
// linked-list ordering, for the items of a SINGLE list.
//
// Shared between the client Dexie `.upgrade()` (local IndexedDB rows) and the
// offline server migration script (at-rest blobs in SQLite) so both produce the
// exact same chain. See memory: project_data_format_versioning.
//
// Real-world data (observed on the prod server) is not clean: a list can hold a
// mix of legacy position-only items and already-migrated after_id items, because
// old and new clients both wrote for a while. This function handles all three
// cases and reports when a list was internally mixed (its recovered order is a
// heuristic, not a faithful reconstruction — flag it so it can be reviewed).

export interface OrderableItem {
  id: string;
  /** Present on already-migrated items (string or null). Absent on legacy items. */
  after_id?: string | null;
  /** Present on legacy items. */
  position?: number;
  created_at?: number;
}

export interface AfterIdMigrationResult {
  /** id → new after_id pointer, forming one clean chain over all input items. */
  afterIds: Map<string, string | null>;
  /**
   * True when the list mixed legacy position-only items with after_id items.
   * Such lists have no unambiguous original order; the returned chain applies a
   * heuristic (after_id chain first, then legacy items by position) and callers
   * should surface these for manual review.
   */
  mixed: boolean;
}

function hasAfterId(item: OrderableItem): boolean {
  return item.after_id !== undefined;
}

// Resolve items linked by after_id into chain order. Forks (multiple items
// sharing an after_id, from concurrent edits) break by created_at; orphans
// (dangling after_id) are appended at the end. Mirrors the client's
// resolveChain, but self-contained so @listr/shared stays framework-free.
function resolveLinked(items: OrderableItem[]): OrderableItem[] {
  const byAfterId = new Map<string | null, OrderableItem[]>();
  for (const item of items) {
    const key = item.after_id ?? null;
    if (!byAfterId.has(key)) byAfterId.set(key, []);
    byAfterId.get(key)!.push(item);
  }

  const childrenOf = (afterId: string | null): OrderableItem[] =>
    (byAfterId.get(afterId) ?? []).slice().sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));

  const result: OrderableItem[] = [];
  const visited = new Set<string>();
  // DFS with an explicit stack (emit on pop). Children are pushed in reverse
  // sorted order so the earliest-created sibling is popped — and emitted — first.
  const stack: OrderableItem[] = childrenOf(null).reverse();

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (visited.has(item.id)) continue; // cycle guard
    visited.add(item.id);
    result.push(item);
    const kids = childrenOf(item.id);
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }

  // Append orphans whose after_id points at a missing/deleted item.
  for (const item of items) {
    if (!visited.has(item.id)) result.push(item);
  }
  return result;
}

/**
 * Convert one list's items to an after_id chain. Returns the new after_id for
 * every item (in a single chain) plus whether the list was internally mixed.
 */
export function migrateListToAfterId(items: OrderableItem[]): AfterIdMigrationResult {
  const linked = items.filter(hasAfterId);
  const legacy = items.filter((i) => !hasAfterId(i));

  const linkedOrder = resolveLinked(linked);
  const legacyOrder = legacy
    .slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a.created_at ?? 0) - (b.created_at ?? 0));

  const mixed = linkedOrder.length > 0 && legacyOrder.length > 0;

  // Heuristic for mixed lists: the after_id chain is authoritative (written by
  // newer clients), legacy position-only items follow in numeric order.
  const order = [...linkedOrder, ...legacyOrder];

  const afterIds = new Map<string, string | null>();
  let prevId: string | null = null;
  for (const item of order) {
    afterIds.set(item.id, prevId);
    prevId = item.id;
  }

  return { afterIds, mixed };
}
