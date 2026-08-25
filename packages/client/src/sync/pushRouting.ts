/**
 * Which connections a live push (or the initial-sync equivalent) should
 * reach, and under what key — §3.3.1 of work/auth-design.md.
 *
 * This is the routing predicate `doInitialSync` and `pushEntity`/`pushDelete`
 * must agree on, extracted so the two paths cannot drift: both call
 * `connectionsForPush` rather than reimplementing the two guards below.
 *
 * Each connection has already resolved its own key for the entity being
 * pushed (its board's custom key, or that connection's own home key as
 * fallback — see SyncClient.effectiveKeyForEntity/EntityId, which take the
 * home key as a parameter for exactly this reason: the fallback can differ
 * per connection once home keys are server-assigned, Phase 1). What's left
 * for this function to decide is:
 *
 * - `boardBinding`: an entity whose board is explicitly bound (§3.3.1 item 4)
 *   to a DIFFERENT server than a connection's is withheld from that
 *   connection regardless of key. This check is needed *in addition to* the
 *   key check below: a home-keyed board's key is unconditionally present in
 *   every connection's `keys` (keysForEndpoint always includes the home
 *   key), so the key check alone could never catch a home-keyed board bound
 *   elsewhere — only this binding lookup can. `null` means "not bound to any
 *   one server" (not yet placed, or not board-scoped at all, e.g. an asset)
 *   and is never excluded.
 * - `keys.includes(key)`: a connection that was never offered this key (most
 *   notably a brand-new board's freshly generated key, which only appears in
 *   the *next* `hello` after `recomputeAllKeys` reconnects) does not get the
 *   push live. It is not lost — the next reconnect's `doInitialSync` picks it
 *   up via that key's per-key `since`, which defaults to 0 for a key this
 *   connection has never declared.
 */

export interface PushRoutingConnection {
  epId: string;
  serverId: string;
  keys: string[];
  /** This connection's own resolved key for the entity being pushed. */
  key: string;
}

export interface PushTarget {
  epId: string;
  key: string;
}

export function connectionsForPush(
  boardBinding: string | null,
  connections: PushRoutingConnection[],
): PushTarget[] {
  return connections
    .filter((c) => (boardBinding === null || boardBinding === c.serverId) && c.keys.includes(c.key))
    .map((c) => ({ epId: c.epId, key: c.key }));
}
