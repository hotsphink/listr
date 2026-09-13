/**
 * The connection a grant-issuing UI must send on: the server this client is
 * registered with, plus a socket to it that is open right now.
 *
 * AdminPage and BoardShareModal both need this, so the Dexie subscriptions
 * live at module scope rather than inside either component. They run for the
 * life of the app, the same way syncClient and endpointStatuses do.
 */
import { createSignal } from "solid-js";
import { liveQuery } from "dexie";
import { db, type ServerIdentity, type SyncEndpoint } from "../db/database.js";
import { endpointStatuses } from "../store/endpointStatuses.js";
import type { EndpointStatus } from "../store/endpointStatuses.js";

const [endpoints, setEndpoints] = createSignal<SyncEndpoint[]>([]);
const [identities, setIdentities] = createSignal<ServerIdentity[]>([]);

liveQuery(() => db.sync_endpoints.orderBy("position").toArray()).subscribe(setEndpoints);
// Per-server registration state. Identity comes from the server, via the `ok`
// message's fields, and never from anything typed into the UI.
liveQuery(() => db.server_identity.toArray()).subscribe(setIdentities);

export const syncEndpoints = endpoints;
export const serverIdentities = identities;

/** The active registration, picking the first when several servers are
 * configured, the same "pick one" convention SyncClient.getPrimaryServerId
 * uses. */
export const primaryIdentity = (): ServerIdentity | null =>
  identities().find((i) => i.state === "active") ?? null;

/**
 * The endpoint id currently reaching whichever server the active identity is
 * on. Identity is keyed by server_id, while the wire calls (createGrant,
 * listClients, setDisplayName) are made against a connection, keyed by
 * endpoint id.
 *
 * Only a connection that can be sent on right now qualifies, not merely one
 * associated with this server. Neither `sync_endpoints.last_server_id` nor
 * `EndpointStatus.serverId` is sufficient on its own, since both survive a
 * dropped socket: last_server_id is persisted, and an EndpointStatus keeps the
 * serverId from its last handshake even once the phase has gone to "error",
 * because the close handler sets only phase and message. Either could hand
 * back a dead endpoint, and every wire call throws "no open connection" on
 * one. Requiring phase === "ready" is what makes this accurate, and it stays
 * reactive because endpointStatuses updates on connect and close.
 */
export const primaryEndpointId = (): string | null => {
  const serverId = primaryIdentity()?.server_id;
  if (!serverId) return null;
  for (const ep of endpoints()) {
    const status = endpointStatuses()[ep.id] as EndpointStatus | undefined;
    if (status?.phase === "ready" && status.serverId === serverId) return ep.id;
  }
  return null;
};
