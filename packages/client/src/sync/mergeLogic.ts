export type EntityType = "category" | "list" | "item";

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
