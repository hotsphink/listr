/**
 * Server-scoped sync keys (§3.3.1 of work/auth-design.md).
 *
 * Phase 0.5 scoped the `shared_keys` roster but left the home key and this
 * device's own board keys unconditional — sent to every configured endpoint
 * regardless of which server it actually is. This closes that [GAP]:
 * `keysForEndpoint` now returns only what actually belongs to the endpoint
 * being connected to, nothing unconditional.
 *
 * - `homeKeyForServer` is the caller's resolved home key for this connection
 *   (see SyncClient.resolveConnectionKeys) — already specific to one
 *   connection by construction, so it needs no filtering here.
 * - `boardKeys` and `sharedKeyRoster` are both `ScopedKeyRow[]`: a nullable
 *   `server_id` where null means "not yet scoped to any server" (every
 *   pre-existing shared_keys row migrated to null, and every board not yet
 *   bound via board_server_binding is null too — see database.ts) and is
 *   offered to every endpoint, preserving prior behavior for anything not
 *   yet placed. Once a row is scoped to a real server_id, it's offered only
 *   to an endpoint already known (via `sync_endpoints.last_server_id`,
 *   trust-on-first-use) to be that same server.
 *
 * A never-before-seen endpoint (no known server_id yet) therefore only ever
 * sees still-unscoped rows, which sidesteps the circularity of not knowing a
 * server's id until either the preflight or `ok` resolves it.
 */

export interface ScopedKeyRow {
  key: string;
  server_id: string | null;
}

/**
 * The sync keys to offer one endpoint in `hello`.
 *
 * Returns exactly: `homeKeyForServer`, plus every `boardKeys` / `sharedKeyRoster`
 * row that's either unscoped (`server_id === null`) or scoped to this exact
 * endpoint's known server (`endpointServerId`). A row scoped to a *different*
 * server is withheld — that's the whole point: stop volunteering a key that
 * belongs to one world to a different one, for boards as much as for shares.
 */
export function keysForEndpoint(
  homeKeyForServer: string,
  boardKeys: ScopedKeyRow[],
  sharedKeyRoster: ScopedKeyRow[],
  endpointServerId: string | null,
): string[] {
  const scope = (rows: ScopedKeyRow[]) =>
    rows.filter((r) => r.server_id === null || r.server_id === endpointServerId).map((r) => r.key);
  return [...new Set([homeKeyForServer, ...scope(boardKeys), ...scope(sharedKeyRoster)])];
}
