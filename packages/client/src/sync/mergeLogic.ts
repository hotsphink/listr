export type EntityType = "board" | "list" | "item" | "asset" | "integration_result";

/**
 * Returns true if a tombstone (deleted_at) should delete the local entity.
 * Tombstone wins when deleted_at >= entity.updated_at, i.e. the entity is
 * at most as recent as the deletion. Entity wins if it was updated after the
 * tombstone (updated_at > deleted_at).
 */
export function shouldDeleteOnTombstone(
  entity: { updated_at: number } | undefined,
  deletedAt: number,
): boolean {
  return !entity || entity.updated_at <= deletedAt;
}

/**
 * Decides whether an incoming entity from sync should be applied locally.
 * Returns the value to store, or null if the local version should be kept.
 *
 * Special cases:
 *  - view_mode on lists is a per-device preference and is never overwritten
 *    by an incoming entity (but IS used if no local copy exists yet).
 */
export function applyIncomingEntity(
  entityType: EntityType,
  incoming: Record<string, unknown>,
  existing: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (existing && (incoming.updated_at as number) <= (existing.updated_at as number)) {
    return null;
  }
  if (entityType === "list" && existing?.view_mode != null) {
    return { ...incoming, view_mode: existing.view_mode };
  }
  return incoming;
}
