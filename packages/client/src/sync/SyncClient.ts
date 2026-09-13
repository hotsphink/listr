import { db, type ClientIdentity, type ServerIdentity } from "../db/database.js";
import { removeKeyLocal } from "../db/keyCleanup.js";
import type { Board, List } from "@listr/shared";
import { PROTOCOL_VERSION } from "./protocol.js";
import { setSyncStatus, setSyncStatusMessage } from "./syncStore.js";
import { applyIncomingEntity, shouldDeleteOnTombstone, type EntityType } from "./mergeLogic.js";
import { variantAllowed } from "./variantGuard.js";
import { keysForEndpoint, sameKeySet, type ScopedKeyRow } from "./keyScoping.js";
import { connectionsForPush, type PushRoutingConnection } from "./pushRouting.js";
import { buildAuthPayload } from "./clientIdentity.js";
import { exportPublicJwk, getOrCreateClientIdentity, signAuthPayload } from "./clientKeys.js";
import { assetToSync, assetFromSync, registerAsset } from "./assetStore.js";
import { GRANT_FAILURE_REASONS } from "./grantReasons.js";
import {
  setEndpointStatus,
  removeEndpointStatus,
  type EndpointPhase,
  type EndpointStatus,
} from "../store/endpointStatuses.js";

const WS_CLOSE_MESSAGES: Record<number, string> = {
  1001: "Server going away",
  1002: "Protocol error",
  1003: "Unsupported data type",
  1006: "DNS error or connection refused",
  1007: "Invalid message encoding",
  1008: "Policy violation",
  1009: "Message too large",
  1011: "Server internal error",
  1012: "Server restarting",
  1013: "Server temporarily unavailable",
  1014: "Bad gateway",
  1015: "TLS handshake failed",
};

function wsCloseMessage(e: CloseEvent): string {
  return e.reason || WS_CLOSE_MESSAGES[e.code] || "Disconnected";
}

export interface SyncEndpointConfig {
  id: string;
  host: string;
  port: number;
  enabled: boolean;
  secure: boolean;
  lastServerId: string | null;
}

export interface ServerUserKey {
  key: string;
  name: string | null;
}

/** This device's identity on the wire: the RFC 7638 thumbprint plus the
 * exported public JWK, both derived once from the local keypair and reused for
 * every connection. */
interface ClientContext {
  clientId: string;
  pubkeyJwk: Record<string, unknown>;
  sign: (payload: Uint8Array) => Promise<string>;
}

interface EndpointCallbacks {
  onStatus: (status: EndpointStatus) => void;
  onReady: (
    send: (msg: unknown) => void,
    serverId: string,
    homeKey: string,
    userId: string,
    caps: string[],
    displayName: string | null,
    userKeys: ServerUserKey[],
  ) => void;
  /** The handshake completed but this client is not registered on this server.
   * `send` stays live so a later `redeem_grant`, from the join UI or from
   * SyncClient.redeemGrant below, can complete registration on this same
   * connection without a reconnect. */
  onNeedsGrant: (send: (msg: unknown) => void, serverId: string) => void;
  onMessage: (msg: unknown) => void;
  onNeedsRetry: () => void;
}

class EndpointConnection {
  config: SyncEndpointConfig;
  currentPhase: EndpointPhase = "connecting";
  private ws: WebSocket | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  // Known only once `challenge` arrives. Held so that a later `error`, such as
  // suspended or revoked, can still be attributed to a server_id.
  private challengeServerId: string | null = null;

  constructor(
    config: SyncEndpointConfig,
    private keys: string[],
    private clientCtx: ClientContext,
    private callbacks: EndpointCallbacks,
  ) {
    this.config = { ...config };
  }

  start(): void {
    this.running = true;
    this.doConnect();
  }

  stop(): void {
    this.running = false;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
  }

  resetAndReconnect(): void {
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    if (this.running) this.doConnect();
  }

  scheduleRetry(delayMs: number): void {
    if (!this.running || this.retryTimer !== null) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.doConnect();
    }, delayMs);
  }

  cancelRetry(): void {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  get hasRetryPending(): boolean {
    return this.retryTimer !== null;
  }

  /** The scoped key list this connection sent in `hello`. SyncClient reads it
   * back when it needs the same list later, such as for a promoted standby's
   * initial sync. */
  get helloKeys(): string[] {
    return this.keys;
  }

  private clearTimers(): void {
    if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private doConnect(): void {
    if (!this.running) return;
    const { host, port, secure } = this.config;
    if (!host) {
      this.setPhase({ phase: "error", message: "No host configured" });
      this.callbacks.onNeedsRetry();
      return;
    }
    const proto = secure ? "wss" : "ws";
    const url = `${proto}://${host}:${port}/sync`;
    this.setPhase({ phase: "connecting" });
    this.challengeServerId = null;

    try {
      const ws = new WebSocket(url);
      this.ws = ws;

      let timeoutMessage: string | null = null;

      this.connectTimer = setTimeout(() => {
        this.connectTimer = null;
        if (ws.readyState === WebSocket.CONNECTING) {
          timeoutMessage = "Timed out — host unreachable or port blocked";
          ws.close();
        }
      }, 10_000);

      const clearConnectTimer = () => {
        if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      };

      ws.addEventListener("open", () => {
        clearConnectTimer();
        this.setPhase({ phase: "handshaking" });
        // Identity travels on every connection as client_id + pubkey_jwk, so
        // 'hello' carries no bearer credential.
        ws.send(JSON.stringify({
          type: "hello",
          protocol_version: PROTOCOL_VERSION,
          client_id: this.clientCtx.clientId,
          pubkey_jwk: this.clientCtx.pubkeyJwk,
          keys: this.keys,
        }));
      });

      ws.addEventListener("message", (e: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(e.data as string); } catch { return; }

        if (msg.type === "challenge") {
          this.handleChallenge(ws, msg);
          return;
        }

        if (msg.type === "ok") {
          this.handleOk(ws, msg);
          return;
        }

        if (msg.type === "needs_grant") {
          this.setPhase({ phase: "needs_grant", serverId: this.challengeServerId ?? undefined });
          this.callbacks.onNeedsGrant(this.makeSend(ws), this.challengeServerId ?? "");
          return;
        }

        if (msg.type === "error" && this.currentPhase !== "ready") {
          const reason = typeof msg.reason === "string" ? msg.reason : undefined;
          // A grant operation's failure (peek_grant or redeem_grant while
          // parked in "needs_grant") is recoverable and must NOT tear the
          // connection down. SyncClient.redeemGrant reaches this connection
          // via allSenders precisely so the join UI can show the error and let
          // the user retry on the same connection. Everything else reaching
          // this branch (protocol, bad_signature, suspended, revoked, or an
          // unrecognized reason) is connection-fatal.
          if (!reason || !GRANT_FAILURE_REASONS.has(reason)) {
            this.setPhase({
              phase: "error",
              message: msg.message ?? "Server rejected connection",
              serverId: this.challengeServerId ?? undefined,
              authReason: reason,
            });
            ws.close();
            return;
          }
        }

        this.callbacks.onMessage(msg);
      });

      ws.addEventListener("error", clearConnectTimer);

      ws.addEventListener("close", (e: CloseEvent) => {
        clearConnectTimer();
        this.ws = null;
        if (this.running) {
          this.setPhase({ phase: "error", message: timeoutMessage ?? wsCloseMessage(e) });
          this.callbacks.onNeedsRetry();
        }
      });
    } catch (e) {
      if (this.connectTimer) { clearTimeout(this.connectTimer); this.connectTimer = null; }
      this.setPhase({ phase: "error", message: String(e) });
      if (this.running) this.callbacks.onNeedsRetry();
    }
  }

  private makeSend(ws: WebSocket): (msg: unknown) => void {
    return (m: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    };
  }

  /** The challenge step: check variant and server_id conflict BEFORE doing any
   * crypto, then sign and send `auth`. */
  private async handleChallenge(ws: WebSocket, msg: any): Promise<void> {
    const serverId = typeof msg.server_id === "string" ? msg.server_id : "";
    this.challengeServerId = serverId || null;

    // Dev/prod variant guard. A server that reports no variant is running an
    // older build without the field. Treat that as unknown and allow it with a
    // warning, so this client can still talk to such a server.
    const serverVariant = typeof msg.variant === "string" ? msg.variant : undefined;
    if (serverVariant === undefined) {
      console.warn(`[sync] ${this.config.host}:${this.config.port} did not report a variant (older server), allowing connection`);
    } else if (!variantAllowed(serverVariant, __VARIANT__)) {
      this.setPhase({
        phase: "variant_mismatch",
        serverVariant,
        clientVariant: __VARIANT__,
        message: `This is a "${serverVariant}" server; this client is built for "${__VARIANT__}"`,
      });
      return;
    }

    const known = this.config.lastServerId;
    if (known && serverId && serverId !== known) {
      this.setPhase({ phase: "conflict", knownId: known, newId: serverId });
      return;
    }

    const nonce = typeof msg.nonce === "string" ? msg.nonce : "";
    try {
      const payload = buildAuthPayload(serverId, nonce, this.clientCtx.clientId);
      const sig = await this.clientCtx.sign(payload);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "auth", sig }));
    } catch (err) {
      console.error("[sync] failed to sign auth challenge:", err);
      this.setPhase({ phase: "error", message: "Failed to sign authentication challenge" });
      ws.close();
    }
  }

  private handleOk(ws: WebSocket, msg: any): void {
    const serverId = this.challengeServerId ?? (typeof msg.server_id === "string" ? msg.server_id : "");
    const userId = typeof msg.user_id === "string" ? msg.user_id : "";
    // The home key is server-assigned and arrives here. The client never
    // invents or asserts one.
    const homeKey = typeof msg.home_key === "string" ? msg.home_key : "";
    const caps: string[] = Array.isArray(msg.caps) ? msg.caps.filter((c: unknown) => typeof c === "string") : [];
    const displayName = typeof msg.display_name === "string" ? msg.display_name : null;
    const userKeys: ServerUserKey[] = Array.isArray(msg.user_keys) ? msg.user_keys : [];

    this.setPhase({ phase: "ready", serverId });
    this.callbacks.onReady(this.makeSend(ws), serverId, homeKey, userId, caps, displayName, userKeys);
  }

  private setPhase(status: EndpointStatus): void {
    this.currentPhase = status.phase;
    this.callbacks.onStatus(status);
  }
}

// One primary connection's outgoing plumbing, plus everything pushEntity,
// pushDelete, associateKey, and leaveKey need to build a message *for that
// connection specifically*: `send`, the scoped `keys` list this connection
// offered in `hello` (always including its server-assigned home key once
// known, see SyncClient.onReady), its resolved home key, and the server_id it
// is bound to, for the board-binding exclusion. One primary per distinct
// server_id, keyed by endpoint id, since claimOrDefer collapses multiple
// endpoints on the same server down to one.
interface PrimaryConnection {
  send: (msg: unknown) => void;
  keys: string[];
  homeKeyForServer: string;
  serverId: string;
}

class SyncClient {
  private connections = new Map<string, EndpointConnection>();
  // Only the primary endpoint per distinct server_id, used for outgoing push.
  private primaries = new Map<string, PrimaryConnection>();
  // Every ready connection regardless of primary/standby role, so a standby
  // can be promoted to primary without reconnecting when the primary drops.
  // Also holds a connection's `send` while it's sitting in "needs_grant",
  // so SyncClient.redeemGrant can reach it without a reconnect.
  private allSenders = new Map<string, (msg: unknown) => void>();
  private readyServerId = new Map<string, string>(); // endpoint id -> server_id, while ready
  private primaryForServerId = new Map<string, string>(); // server_id -> primary endpoint id
  // endpoint id -> the resolved per-server home key that connection used. Read
  // back when promoting a standby to primary (releasePrimaryIfHeld) so it can
  // build that connection's PrimaryConnection without re-resolving. Covers
  // every ready connection, primary or standby; `primaries` above only covers
  // the ones actually pushing.
  private resolvedHomeKeyByEndpoint = new Map<string, string>();
  // Listeners the join/grant UI registers while a peek_grant, redeem_grant,
  // create_grant, or list_clients reply is in flight on that connection. A
  // successful `redeem_grant` does not need this: it arrives as an ordinary
  // `ok`, handled by onReady/upsertServerIdentity and observable reactively
  // via db.server_identity. This covers everything else, namely peek results,
  // grant creation results, the device list, and grant-operation failures,
  // which do not tear the connection down (see GRANT_FAILURE_REASONS) and so
  // need somewhere to land.
  // Several components listen on one endpoint at once: AdminPage holds a
  // long-lived listener for the device list and display-name confirmation,
  // while GrantModal, RedeemGrantModal, and JoinPage each register their own
  // while open. Use a Set so they coexist. With a single slot a modal would
  // displace AdminPage's listener for the rest of AdminPage's life, since its
  // effect never re-runs while the endpoint id stays the same.
  private grantReplyListeners = new Map<string, Set<(msg: any) => void>>();
  private statusPhases = new Map<string, EndpointPhase>();
  private currentEndpoints: SyncEndpointConfig[] = [];

  // This device's keypair-derived identity, generated lazily once an endpoint
  // is enabled. `pubkeyJwk` is exported once and cached alongside it rather
  // than re-exported per connection.
  private identity: ClientIdentity | null = null;
  private pubkeyJwk: Record<string, unknown> | null = null;

  // Per-server registration state: server_id -> what that server said about
  // this client. Mirrors db.server_identity so resolveConnectionKeys can read
  // it synchronously, and is updated reactively from updateServerIdentities
  // (App.tsx's liveQuery over db.server_identity).
  private serverIdentities = new Map<string, { userId: string | null; homeKey: string | null }>();

  private clientId = "";
  // Signature of the inputs to keysForEndpoint, used only to skip a
  // reconnect-all when recomputeAllKeys is triggered by a no-op change, such
  // as a liveQuery re-firing with equivalent data. Not itself a key list:
  // each endpoint computes its own scoped list at connect time.
  private lastKeysSignature = "";

  // Entity routing caches, populated from board/list subscriptions and pushes
  private boardSyncKeys = new Map<string, string>(); // boardId -> sync_key (only boards with custom key)
  private allBoardIds = new Set<string>(); // every local board id, custom-keyed or not, for bindUnboundBoards
  private listBoardMap = new Map<string, string>(); // listId -> boardId
  private itemListMap = new Map<string, string>(); // itemId -> listId
  // Keys added via QR share or learned from the server (ok.user_keys),
  // independent of local boards. See keyScoping.ts for how server_id scopes
  // which endpoints each one is offered to.
  private sharedKeyRoster: ScopedKeyRow[] = [];
  // Local-only board-to-server binding. boardId -> server_id, or absent/null
  // for "not yet placed". See database.ts's BoardServerBinding and
  // keyScoping.ts's null-means-unscoped convention.
  private boardServerBinding = new Map<string, string | null>();

  /** Called reactively from App.tsx whenever sync_endpoints changes. Create
   * this device's keypair lazily, the first time any endpoint is enabled and
   * never before, so an offline-only user never mints one. A change that
   * leaves nothing enabled just tears connections down, with no keypair
   * involved at all. */
  setEndpoints(endpoints: SyncEndpointConfig[]): void {
    this.currentEndpoints = endpoints;
    if (!endpoints.some((e) => e.enabled)) {
      this.applyEndpoints(endpoints);
      return;
    }
    if (this.identity) {
      this.applyEndpoints(endpoints);
      return;
    }
    getOrCreateClientIdentity()
      .then(async (identity) => {
        this.identity = identity;
        this.pubkeyJwk = await exportPublicJwk(identity);
        this.clientId = identity.client_id;
        this.applyEndpoints(this.currentEndpoints);
      })
      .catch((err) => console.error("[sync] failed to create client identity:", err));
  }

  /** Called reactively from App.tsx whenever the boards table changes. */
  updateBoardKeys(boards: Board[]): void {
    this.boardSyncKeys.clear();
    this.allBoardIds.clear();
    for (const board of boards) {
      this.allBoardIds.add(board.id);
      if (board.sync_key) this.boardSyncKeys.set(board.id, board.sync_key);
    }
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever shared_keys table changes. */
  updateSharedKeys(rows: ScopedKeyRow[]): void {
    this.sharedKeyRoster = rows;
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever the board_server_binding table changes. */
  updateBoardBindings(rows: { board_id: string; server_id: string | null }[]): void {
    this.boardServerBinding.clear();
    for (const r of rows) this.boardServerBinding.set(r.board_id, r.server_id ?? null);
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever server_identity changes. This is
   * where a server-assigned home key becomes visible to
   * resolveConnectionKeys/keysForEndpoint. */
  updateServerIdentities(rows: ServerIdentity[]): void {
    this.serverIdentities.clear();
    for (const r of rows) this.serverIdentities.set(r.server_id, { userId: r.user_id, homeKey: r.home_key });
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever the lists table changes. */
  updateListBoards(lists: List[]): void {
    this.listBoardMap.clear();
    for (const list of lists) {
      this.listBoardMap.set(list.id, list.board_id);
    }
  }

  /**
   * The server_id of the currently active primary connection, for binding a
   * newly created board to the server it belongs to: a board created while a
   * server is primary binds to that server. If more than one distinct server
   * is simultaneously primary (the multi-server case, see PrimaryConnection's
   * doc comment), this returns one of them arbitrarily rather than guessing.
   * A board is only ever placed once and can be moved later like any other
   * resync.
   */
  getPrimaryServerId(): string | null {
    return [...this.primaryForServerId.keys()][0] ?? null;
  }

  async forceFullSync(): Promise<void> {
    await Promise.all([db.boards.clear(), db.lists.clear(), db.items.clear(), db.assets.clear(), db.tombstones.clear(), db.integration_results.clear()]);
    await db.key_sync_state.clear();
    this.boardSyncKeys.clear();
    this.listBoardMap.clear();
    this.itemListMap.clear();
    for (const conn of this.connections.values()) conn.resetAndReconnect();
  }

  async forcePushAll(): Promise<void> {
    await db.key_sync_state.clear();
    for (const conn of this.connections.values()) conn.resetAndReconnect();
  }

  /**
   * Registration plumbing for the join UI: redeem a grant on an already-open
   * connection sitting in "needs_grant", or, for a `share` grant, one that is
   * already authenticated. This is just the wire call. The server's reply is
   * an ordinary `ok` or `error`, handled by the same EndpointConnection
   * message path as any other `ok`.
   */
  redeemGrant(endpointId: string, grantId: string, secret: string, label?: string): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`redeemGrant: endpoint ${endpointId} has no open connection`);
    send({ type: "redeem_grant", grant_id: grantId, secret, label: label ?? null });
  }

  /**
   * Register interest in the next grant-related reply (peek, create, redeem
   * failure, or clients list) on `endpointId`'s connection. Returns an
   * unsubscribe function. Every listener registered on an endpoint sees every
   * such reply, so a long-lived listener and a modal's short-lived one coexist
   * (see grantReplyListeners).
   */
  onGrantReply(endpointId: string, listener: (msg: any) => void): () => void {
    let listeners = this.grantReplyListeners.get(endpointId);
    if (!listeners) {
      listeners = new Set();
      this.grantReplyListeners.set(endpointId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.grantReplyListeners.get(endpointId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.grantReplyListeners.delete(endpointId);
    };
  }

  /** Read-only preview of a grant: the greeting and the voucher's display
   * name, without consuming a use. Works on a connection parked in
   * "needs_grant". See redeemGrant's doc comment on why `allSenders`, rather
   * than just `primaries`, is the right map to reach through. */
  peekGrant(endpointId: string, grantId: string, secret: string): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`peekGrant: endpoint ${endpointId} has no open connection`);
    send({ type: "peek_grant", grant_id: grantId, secret });
  }

  /** Create a grant on behalf of the current user of `endpointId`'s
   * connection. That connection must already be authenticated (`ready`), since
   * the issuer is implicit in who you are. Cap and attenuation enforcement
   * happens server-side regardless of what the UI gates on. */
  createGrant(
    endpointId: string,
    params: {
      kind: "invite" | "device" | "share" | "guest";
      caps?: string[];
      payload?: string;
      /** Display name for `payload`, so a shared group arrives named. */
      payloadName?: string;
      greeting?: string | null;
      expiresAt?: number;
      usesRemaining?: number;
    },
  ): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`createGrant: endpoint ${endpointId} has no open connection`);
    send({
      type: "create_grant",
      kind: params.kind,
      caps: params.caps,
      payload: params.payload,
      payload_name: params.payloadName,
      greeting: params.greeting ?? null,
      expires_at: params.expiresAt,
      uses_remaining: params.usesRemaining,
    });
  }

  /** Rename one of this user's own devices. The server replies with the
   * refreshed `clients` list, so callers need not re-request it. */
  setClientLabel(endpointId: string, clientId: string, label: string | null): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`setClientLabel: endpoint ${endpointId} has no open connection`);
    send({ type: "set_client_label", client_id: clientId, label });
  }

  /** Set this user's own display_name: a self-chosen nickname, never
   * validated. */
  setDisplayName(endpointId: string, displayName: string | null): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`setDisplayName: endpoint ${endpointId} has no open connection`);
    send({ type: "set_display_name", display_name: displayName });
  }

  /** Ask the server for this user's registered clients, its "your devices"
   * list. The reply arrives via onGrantReply as `{type:"clients",...}`. */
  listClients(endpointId: string): void {
    const send = this.allSenders.get(endpointId);
    if (!send) throw new Error(`listClients: endpoint ${endpointId} has no open connection`);
    send({ type: "list_clients" });
  }

  pushEntity(entityType: EntityType, data: unknown): void {
    const d = data as any;
    // Update routing caches so future pushDelete calls can find the key
    if (entityType === "list") this.listBoardMap.set(d.id, d.board_id);
    if (entityType === "item") this.itemListMap.set(d.id, d.list_id);

    const boardId = this.boardIdForEntity(entityType, d);
    const boardBinding = boardId !== null ? (this.boardServerBinding.get(boardId) ?? null) : null;
    const connections: PushRoutingConnection[] = [...this.primaries.entries()].map(([epId, c]) => ({
      epId,
      serverId: c.serverId,
      keys: c.keys,
      key: this.effectiveKeyForEntity(entityType, d, c.homeKeyForServer),
    }));
    for (const t of connectionsForPush(boardBinding, connections)) {
      this.primaries.get(t.epId)!.send({ type: "push_entity", entity_type: entityType, sync_key: t.key, data });
    }
  }

  pushDelete(entityType: EntityType, entityId: string, deletedAt?: number): void {
    // The local tombstone row carries a single sync_key, falling back to
    // whichever primary connection's home key resolves first. That choice is
    // arbitrary once more than one server is primary (see getPrimaryServerId).
    // Per-connection routing below can resolve a different key per connection,
    // since home keys genuinely differ per server, so a tombstone really needs
    // a key *per server* rather than one column. That gap is still open.
    const fallbackHomeKey = [...this.primaries.values()][0]?.homeKeyForServer ?? "";
    const syncKey = this.effectiveKeyForEntityId(entityType, entityId, fallbackHomeKey);
    const deleted_at = deletedAt ?? Date.now();
    db.tombstones
      .put({ id: `${entityType}:${entityId}`, entity_type: entityType, entity_id: entityId, deleted_at, sync_key: syncKey })
      .catch(console.error);

    const boardId = this.boardIdForEntityId(entityType, entityId);
    const boardBinding = boardId !== null ? (this.boardServerBinding.get(boardId) ?? null) : null;
    const connections: PushRoutingConnection[] = [...this.primaries.entries()].map(([epId, c]) => ({
      epId,
      serverId: c.serverId,
      keys: c.keys,
      key: this.effectiveKeyForEntityId(entityType, entityId, c.homeKeyForServer),
    }));
    for (const t of connectionsForPush(boardBinding, connections)) {
      this.primaries.get(t.epId)!.send({ type: "push_delete", entity_type: entityType, entity_id: entityId, deleted_at, sync_key: t.key });
    }
  }

  /** Tell the server this key belongs to the current user, optionally naming
   * it, such as with a board group. Best-effort, and sent per connection using
   * that connection's own scoped key list, mirroring the board_groups
   * reassertion doInitialSync does on every reconnect. Identity is implicit in
   * the authenticated connection, so there is no identity field to send. */
  associateKey(key: string, name?: string): void {
    if (!key) return;
    for (const conn of this.primaries.values()) {
      if (key === conn.homeKeyForServer || !conn.keys.includes(key)) continue;
      conn.send({ type: "associate_key", key, name: name ?? null });
    }
  }

  /** Tell the server to forget this key's association with the current user.
   * Best-effort, and sent per connection. See associateKey. */
  leaveKey(key: string): void {
    if (!key) return;
    for (const conn of this.primaries.values()) {
      if (key === conn.homeKeyForServer || !conn.keys.includes(key)) continue;
      conn.send({ type: "leave_key", key });
    }
  }

  /**
   * Fold keys the server says belong to this user into local state so their
   * boards/lists/items sync down, reusing the shared_keys pipeline
   * (App.tsx's liveQuery -> updateSharedKeys -> recomputeAllKeys -> reconnect).
   *
   * `serverId` is the server that reported these keys. Its `ok.user_keys`
   * echoes back everything `hello` sent it, plus any it already knew, which is
   * a direct signal the key belongs there, so this is also where a
   * still-unscoped roster row gets tagged. Only unscoped rows are tagged: a
   * key another server already claimed is left alone, so two endpoints racing
   * their first connect cannot fight over who owns it.
   */
  private adoptUserKeys(entries: ServerUserKey[], serverId: string | null): void {
    for (const { key, name } of entries) {
      db.shared_keys.get(key).then((existing) => {
        if (!existing) {
          db.shared_keys.put({ key, added_at: Date.now(), board_name: name ?? undefined, server_id: serverId });
        } else if (existing.server_id === null && serverId) {
          db.shared_keys.update(key, { server_id: serverId });
        }
      }).catch(console.error);
      if (name) db.board_groups.put({ key, name, created_at: Date.now() }).catch(console.error);
    }
  }

  /** Create or update this server's server_identity row. An empty `serverId`
   * is a no-op, since a connection that never got as far as `challenge` has
   * nothing to record. */
  private upsertServerIdentity(serverId: string, fields: {
    state: ServerIdentity["state"];
    userId: string | null;
    homeKey: string | null;
    caps: string[];
    displayName: string | null;
  }): void {
    if (!serverId) return;
    db.server_identity.put({
      server_id: serverId,
      state: fields.state,
      user_id: fields.userId,
      home_key: fields.homeKey,
      caps: fields.caps,
      display_name: fields.displayName,
      updated_at: Date.now(),
    }).catch(console.error);
  }

  /** Patch just the display name on an existing server_identity row, leaving
   * the rest of the handshake-derived fields alone. Separate from
   * `upsertServerIdentity` because that one writes a whole row, which is right
   * for the handshake and wrong for a single self-service edit. */
  private updateServerIdentityDisplayName(serverId: string | null, displayName: string | null): void {
    if (!serverId) return;
    db.server_identity
      .update(serverId, { display_name: displayName, updated_at: Date.now() })
      .catch(console.error);
  }

  // `homeKey` is a parameter rather than one client-wide field, so callers can
  // resolve the same entity's key differently per connection. Each server
  // assigns its own home key, so the same board can map to different wire keys
  // on different servers.
  private effectiveKeyForEntity(entityType: EntityType, data: any, homeKey: string): string {
    if (entityType === "board") return data.sync_key || homeKey;
    if (entityType === "list") {
      const boardId = data.board_id as string;
      return this.boardSyncKeys.get(boardId) ?? homeKey;
    }
    if (entityType === "item") {
      const listId = data.list_id as string;
      const boardId = this.listBoardMap.get(listId);
      return boardId ? (this.boardSyncKeys.get(boardId) ?? homeKey) : homeKey;
    }
    return homeKey; // assets are not namespaced
  }

  private effectiveKeyForEntityId(entityType: EntityType, entityId: string, homeKey: string): string {
    if (entityType === "board") return this.boardSyncKeys.get(entityId) ?? homeKey;
    if (entityType === "list") {
      const boardId = this.listBoardMap.get(entityId);
      return boardId ? (this.boardSyncKeys.get(boardId) ?? homeKey) : homeKey;
    }
    if (entityType === "item") {
      const listId = this.itemListMap.get(entityId);
      const boardId = listId ? this.listBoardMap.get(listId) : undefined;
      return boardId ? (this.boardSyncKeys.get(boardId) ?? homeKey) : homeKey;
    }
    return homeKey;
  }

  // The board id an entity belongs to, for the board-binding exclusion.
  // Separate from effectiveKeyForEntity because an unkeyed board (no custom
  // sync_key, so its entities fall back to the home key) still has a binding
  // that must be respected, and a home-keyed board's key alone cannot signal
  // that (see pushRouting.ts's doc comment). null means "not board-scoped at
  // all", as for assets, which are never excluded.
  private boardIdForEntity(entityType: EntityType, data: any): string | null {
    if (entityType === "board") return data.id;
    if (entityType === "list") return (data.board_id as string) ?? null;
    if (entityType === "item") return this.listBoardMap.get(data.list_id as string) ?? null;
    return null;
  }

  private boardIdForEntityId(entityType: EntityType, entityId: string): string | null {
    if (entityType === "board") return entityId;
    if (entityType === "list") return this.listBoardMap.get(entityId) ?? null;
    if (entityType === "item") {
      const listId = this.itemListMap.get(entityId);
      return listId ? (this.listBoardMap.get(listId) ?? null) : null;
    }
    return null;
  }

  // Every distinct custom sync_key among local boards, tagged with the binding
  // of the board or boards that use it. If two boards sharing a group key
  // disagree on which server they are bound to, fall back to unscoped (null)
  // rather than guess. That is the safe direction, since unscoped means "offer
  // to every endpoint" rather than "offer to none".
  private boardKeyRows(): ScopedKeyRow[] {
    const byKey = new Map<string, Set<string | null>>();
    for (const [boardId, key] of this.boardSyncKeys) {
      const serverId = this.boardServerBinding.get(boardId) ?? null;
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key)!.add(serverId);
    }
    return [...byKey.entries()].map(([key, serverIds]) => ({
      key,
      server_id: serverIds.size === 1 ? [...serverIds][0] : null,
    }));
  }

  // Restart the connections whose own scoped key list (keysForEndpoint) changed,
  // so each resends an accurate hello, and leave the rest alone. The key list is
  // a function of the endpoint, namely its resolved server_id and that server's
  // assigned home key, so one server's news routinely leaves another endpoint's
  // list identical. Restarting those too drops live connections for nothing, and
  // it broke the join flow outright: registering a needs_grant state writes
  // server_identity, which lands here, and the reconnect killed the very
  // connection JoinPage had just sent peek_grant on, so the reply was dropped
  // and the screen hung.
  //
  // A signature of the synchronous inputs is the cheap early-out, so an
  // unrelated liveQuery re-fire with equivalent data does no work at all.
  // Identities with no home key are left out of it: a server this client is not
  // registered with yet contributes nothing to any hello.
  private recomputeAllKeys(): void {
    const boardRows = this.boardKeyRows().map((r) => `${r.key}:${r.server_id ?? ""}`).sort();
    const roster = this.sharedKeyRoster.map((r) => `${r.key}:${r.server_id ?? ""}`).sort();
    const identities = [...this.serverIdentities.entries()]
      .filter(([, v]) => v.homeKey)
      .map(([sid, v]) => `${sid}:${v.homeKey}`)
      .sort();
    const signature = JSON.stringify([boardRows, roster, identities]);
    if (signature === this.lastKeysSignature) return;
    this.lastKeysSignature = signature;

    for (const ep of this.currentEndpoints) {
      const conn = this.connections.get(ep.id);
      if (!conn) continue;
      if (sameKeySet(conn.helloKeys, this.resolveConnectionKeys(ep).keys)) continue;
      conn.stop();
      this.connections.delete(ep.id);
      this.primaries.delete(ep.id);
      this.allSenders.delete(ep.id);
      this.statusPhases.delete(ep.id);
      this.releasePrimaryIfHeld(ep.id);
    }
    this.applyEndpoints(this.currentEndpoints);
  }

  private applyEndpoints(endpoints: SyncEndpointConfig[]): void {
    const newIds = new Set(endpoints.map((e) => e.id));

    for (const [id, conn] of this.connections) {
      if (!newIds.has(id)) {
        conn.stop();
        this.connections.delete(id);
        this.primaries.delete(id);
        this.allSenders.delete(id);
        this.releasePrimaryIfHeld(id);
        this.statusPhases.delete(id);
        removeEndpointStatus(id);
      }
    }

    for (const ep of endpoints) {
      if (!ep.enabled) {
        if (this.connections.has(ep.id)) {
          this.connections.get(ep.id)!.stop();
          this.connections.delete(ep.id);
          this.primaries.delete(ep.id);
          this.allSenders.delete(ep.id);
          this.releasePrimaryIfHeld(ep.id);
        }
        this.statusPhases.set(ep.id, "disabled");
        setEndpointStatus(ep.id, { phase: "disabled" });
        continue;
      }

      // Identity not resolved yet: setEndpoints started generation and it has
      // not landed. Leave this endpoint at "connecting" and do nothing
      // further. The identity's `.then` callback re-invokes applyEndpoints
      // once it is ready. Never block on identity before it is needed, and
      // never try to connect without it either.
      if (!this.identity || !this.pubkeyJwk) {
        setEndpointStatus(ep.id, { phase: "connecting" });
        continue;
      }

      if (this.connections.has(ep.id)) {
        const conn = this.connections.get(ep.id)!;
        const prev = conn.config;
        if (prev.host === ep.host && prev.port === ep.port && prev.secure === ep.secure) {
          conn.config = { ...ep };
          if (conn.currentPhase === "conflict") conn.resetAndReconnect();
          continue;
        }
        conn.stop();
        this.primaries.delete(ep.id);
        this.allSenders.delete(ep.id);
        this.releasePrimaryIfHeld(ep.id);
        this.connections.delete(ep.id);
      }

      this.startConnection(ep);
    }

    this.refreshAggregateStatus();
  }

  // Resolve this connection's server_id and the keys to offer it. server_id
  // comes from trust-on-first-use (`sync_endpoints.last_server_id`) and is
  // null for an endpoint never connected to before, in which case
  // keysForEndpoint offers only still-unscoped rows. That is what makes a
  // brand-new endpoint safe before its identity is known.
  //
  // The home key resolves per-server from server_identity: this server's own
  // assignment, or "" when it is unknown because the endpoint has never
  // connected or still needs a grant. Falsy entries are filtered out of the
  // key list below rather than sent as an empty-string "key".
  private resolveConnectionKeys(ep: SyncEndpointConfig): {
    keys: string[];
    serverId: string | null;
    homeKeyUsed: string;
  } {
    const serverId = ep.lastServerId;
    const homeKeyUsed = (serverId ? this.serverIdentities.get(serverId)?.homeKey : null) ?? "";
    const keys = keysForEndpoint(homeKeyUsed, this.boardKeyRows(), this.sharedKeyRoster, serverId).filter(Boolean);
    return { keys, serverId, homeKeyUsed };
  }

  private startConnection(ep: SyncEndpointConfig): void {
    setEndpointStatus(ep.id, { phase: "connecting" });
    this.reallyStartConnection(ep, this.resolveConnectionKeys(ep));
  }

  private reallyStartConnection(
    ep: SyncEndpointConfig,
    resolved: { keys: string[]; serverId: string | null; homeKeyUsed: string },
  ): void {
    const clientCtx: ClientContext = {
      clientId: this.clientId,
      pubkeyJwk: this.pubkeyJwk!,
      sign: (payload) => signAuthPayload(this.identity!, payload),
    };
    const conn = new EndpointConnection(ep, resolved.keys, clientCtx, {
      onStatus: (status) => {
        const wasReady = this.statusPhases.get(ep.id) === "ready";
        if (status.phase !== "ready") {
          this.primaries.delete(ep.id);
          this.allSenders.delete(ep.id);
          this.releasePrimaryIfHeld(ep.id);
        }
        this.statusPhases.set(ep.id, status.phase);
        setEndpointStatus(ep.id, status);

        // A structured account-state rejection (suspended or revoked) still
        // names a real server, so persist that much and let an offline read of
        // server_identity reflect it, without inventing a home key or caps the
        // rejection did not supply.
        if (status.phase === "error" && status.serverId && (status.authReason === "suspended" || status.authReason === "revoked")) {
          const known = this.serverIdentities.get(status.serverId);
          this.upsertServerIdentity(status.serverId, {
            state: status.authReason,
            userId: known?.userId ?? null,
            homeKey: known?.homeKey ?? null,
            caps: [],
            displayName: null,
          });
        }

        if (status.phase === "ready") {
          for (const [id, c] of this.connections) {
            if (id !== ep.id) c.cancelRetry();
          }
        } else if (wasReady && this.primaries.size === 0) {
          for (const [, c] of this.connections) {
            if (c.currentPhase === "error" && !c.hasRetryPending) {
              c.scheduleRetry(5000);
            }
          }
        }

        this.refreshAggregateStatus();
      },
      onReady: (send, serverId, homeKey, userId, caps, displayName, userKeys) => {
        this.allSenders.set(ep.id, send);
        db.sync_endpoints.update(ep.id, { last_server_id: serverId }).catch(console.error);
        this.upsertServerIdentity(serverId, { state: "active", userId, homeKey, caps, displayName });

        // The key list resolved before `ok` arrived may not include the home
        // key, which a brand-new registration learns only here. Fold it in so
        // this connection's own routing (connectionsForPush's
        // `keys.includes(key)` check) does not withhold the very first push of
        // this user's home-namespace boards.
        const effectiveKeys = [...new Set([...resolved.keys, homeKey])].filter(Boolean);

        this.adoptUserKeys(userKeys, serverId);
        this.bindUnboundBoards(serverId);
        this.claimOrDefer(ep.id, serverId, send, effectiveKeys, homeKey);
        this.refreshAggregateStatus();
      },
      onNeedsGrant: (send, serverId) => {
        this.allSenders.set(ep.id, send);
        if (serverId) db.sync_endpoints.update(ep.id, { last_server_id: serverId }).catch(console.error);
        this.upsertServerIdentity(serverId, { state: "needs_grant", userId: null, homeKey: null, caps: [], displayName: null });
        this.refreshAggregateStatus();
      },
      onMessage: (msg) => this.handleMessage(msg, resolved.keys, ep.id),
      onNeedsRetry: () => {
        if (this.primaries.size === 0) {
          conn.scheduleRetry(5000);
        }
        this.refreshAggregateStatus();
      },
    });
    this.connections.set(ep.id, conn);
    conn.start();
  }

  // Bind every local board with no binding, which means not yet placed, to the
  // server that just connected. Idempotent and cheap: once a user's boards are
  // all placed this is a no-op on every subsequent connect.
  private bindUnboundBoards(serverId: string): void {
    for (const boardId of this.allBoardIds) {
      if ((this.boardServerBinding.get(boardId) ?? null) !== null) continue;
      this.boardServerBinding.set(boardId, serverId);
      db.board_server_binding.put({ board_id: boardId, server_id: serverId }).catch(console.error);
    }
  }

  // Two connections landing on the same server_id are almost always the same
  // physical server reached by two different routes, such as a tailnet and a
  // public proxy. Only one of them pushes and pulls: whichever finishes its
  // handshake first, which in practice tracks the lower-latency path. The
  // other stays connected as a hot standby so it can take over instantly if
  // the primary drops, without duplicating outgoing traffic meanwhile.
  private claimOrDefer(epId: string, serverId: string, send: (msg: unknown) => void, keys: string[], homeKeyUsed: string): void {
    this.readyServerId.set(epId, serverId);
    this.resolvedHomeKeyByEndpoint.set(epId, homeKeyUsed);
    const currentPrimary = this.primaryForServerId.get(serverId);
    const isPrimary = !currentPrimary || currentPrimary === epId || !this.connections.has(currentPrimary);
    if (isPrimary) {
      this.primaryForServerId.set(serverId, epId);
      this.primaries.set(epId, { send, keys, homeKeyForServer: homeKeyUsed, serverId });
      setEndpointStatus(epId, { phase: "ready", serverId, primary: true });
      this.doInitialSync(send, keys, serverId, homeKeyUsed).catch(console.error);
    } else {
      this.primaries.delete(epId);
      setEndpointStatus(epId, { phase: "ready", serverId, primary: false });
    }
  }

  // If the endpoint going away was the primary for its server_id, promote a
  // standby connection already sitting on the same server_id, if any.
  private releasePrimaryIfHeld(epId: string): void {
    const serverId = this.readyServerId.get(epId);
    this.readyServerId.delete(epId);
    this.resolvedHomeKeyByEndpoint.delete(epId);
    if (!serverId || this.primaryForServerId.get(serverId) !== epId) return;
    this.primaryForServerId.delete(serverId);

    for (const [otherId, otherServerId] of this.readyServerId) {
      if (otherServerId !== serverId) continue;
      const send = this.allSenders.get(otherId);
      const otherConn = this.connections.get(otherId);
      const otherHomeKey = this.resolvedHomeKeyByEndpoint.get(otherId);
      if (!send || !otherConn || !otherHomeKey) continue;
      // Same fold-in as onReady: the OTHER connection's hello.keys may not
      // include its home key, if that connection is the one that registered,
      // so add it explicitly rather than trusting helloKeys alone.
      const effectiveKeys = [...new Set([...otherConn.helloKeys, otherHomeKey])].filter(Boolean);
      this.primaryForServerId.set(serverId, otherId);
      this.primaries.set(otherId, { send, keys: effectiveKeys, homeKeyForServer: otherHomeKey, serverId });
      setEndpointStatus(otherId, { phase: "ready", serverId, primary: true });
      this.doInitialSync(send, effectiveKeys, serverId, otherHomeKey).catch(console.error);
      break;
    }
  }

  private refreshAggregateStatus(): void {
    const phases = [...this.statusPhases.values()].filter((p) => p !== "disabled");
    if (phases.some((p) => p === "ready")) {
      setSyncStatus("connected");
      setSyncStatusMessage("");
    } else if (phases.some((p) => p === "connecting" || p === "handshaking")) {
      setSyncStatus("connecting");
      setSyncStatusMessage("");
    } else if (phases.some((p) => p === "needs_grant")) {
      setSyncStatus("connecting");
      setSyncStatusMessage("Not registered on this server yet");
    } else if (phases.length > 0 && phases.every((p) => p === "error" || p === "conflict" || p === "variant_mismatch")) {
      setSyncStatus("error");
      setSyncStatusMessage(
        phases.every((p) => p === "conflict")
          ? "Server ID conflict"
          : phases.every((p) => p === "variant_mismatch")
            ? "Wrong server variant"
            : "Connection failed",
      );
    } else {
      setSyncStatus("disconnected");
      setSyncStatusMessage("");
    }
  }

  private async doInitialSync(send: (msg: unknown) => void, keys: string[], serverId: string, homeKeyForServer: string): Promise<void> {
    // Whether this one connection should receive an entity keyed `key` whose
    // board is bound to `boardBinding`. This is the same decision pushEntity
    // and pushDelete make for the live path, through the same
    // `connectionsForPush` (see pushRouting.ts for why both the binding check
    // and the `keys.includes` check are needed). Unbound (null) boards are
    // never excluded, and bindUnboundBoards, which onReady calls just before
    // doInitialSync, has already placed any board still unbound.
    const reachesThisConnection = (boardBinding: string | null, key: string): boolean =>
      connectionsForPush(boardBinding, [{ epId: "self", serverId, keys, key }]).length > 0;

    // Re-assert every locally-known board group's name on each connect, scoped
    // to the keys this connection has. A group key withheld from this
    // endpoint's hello must not be associated with it here either, or the
    // scoping above would be pointless. Send through this connection's own
    // `send` rather than the associateKey() helper, which iterates every
    // primary, so one endpoint reconnecting does not re-send to every other
    // already-connected endpoint. This is fire-and-forget and can be dropped,
    // by racing a connection restart for instance, but redoing it on every
    // connect is idempotent server-side and so is eventually consistent rather
    // than a single best-effort attempt.
    const groups = await db.board_groups.toArray();
    for (const g of groups) {
      if (g.key !== homeKeyForServer && keys.includes(g.key)) {
        send({ type: "associate_key", key: g.key, name: g.name });
      }
    }

    // Fetch per-key since timestamps
    const keyStates = await db.key_sync_state.bulkGet(keys);
    const sinceByKey = new Map(keys.map((k, i) => [k, keyStates[i]?.last_sync_at ?? 0]));
    const minSince = Math.min(...[...sinceByKey.values()]);

    // Build board-to-key and list-to-board maps for routing. These are
    // unfiltered: they resolve keys and bindings, and do not decide what the
    // loops below iterate over.
    const allBoards = await db.boards.toArray();
    const boardKeyMap = new Map<string, string>(
      allBoards.map((b) => [b.id, b.sync_key || homeKeyForServer]),
    );

    const allLists = await db.lists.toArray();
    const listBoardId = new Map<string, string>(allLists.map((l) => [l.id, l.board_id]));

    const boards = await db.boards.where("updated_at").above(minSince).toArray();
    for (const board of boards) {
      const key = board.sync_key || homeKeyForServer;
      const boardBinding = this.boardServerBinding.get(board.id) ?? null;
      if (!reachesThisConnection(boardBinding, key)) continue;
      if (board.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "board", sync_key: key, data: board });
      }
    }

    const lists = await db.lists.where("updated_at").above(minSince).toArray();
    for (const list of lists) {
      const key = boardKeyMap.get(list.board_id) ?? homeKeyForServer;
      const boardBinding = this.boardServerBinding.get(list.board_id) ?? null;
      if (!reachesThisConnection(boardBinding, key)) continue;
      if (list.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "list", sync_key: key, data: list });
      }
    }

    const items = await db.items.where("updated_at").above(minSince).toArray();
    for (const item of items) {
      const boardId = listBoardId.get(item.list_id);
      const key = boardId ? (boardKeyMap.get(boardId) ?? homeKeyForServer) : homeKeyForServer;
      const boardBinding = boardId ? (this.boardServerBinding.get(boardId) ?? null) : null;
      if (!reachesThisConnection(boardBinding, key)) continue;
      if (item.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "item", sync_key: key, data: item });
        this.itemListMap.set(item.id, item.list_id);
      }
    }

    const assets = await db.assets.where("updated_at").above(minSince).toArray();
    for (const a of assets) {
      send({ type: "push_entity", entity_type: "asset", sync_key: homeKeyForServer, data: assetToSync(a) });
    }

    // Tombstones carry no board id (see pushDelete's comment on the single
    // `sync_key` column), so there is no binding check here, only the key
    // check. A tombstone whose sync_key is not in `keys` is withheld, because
    // `sinceByKey.get(syncKey)` would otherwise default to 0 for a key this
    // connection never declared and push it regardless.
    const tombstones = await db.tombstones.where("deleted_at").above(minSince).toArray();
    for (const t of tombstones) {
      const syncKey = t.sync_key ?? homeKeyForServer;
      if (!reachesThisConnection(null, syncKey)) continue;
      if (t.deleted_at > (sinceByKey.get(syncKey) ?? 0)) {
        send({ type: "push_delete", entity_type: t.entity_type, entity_id: t.entity_id, deleted_at: t.deleted_at, sync_key: syncKey });
      }
    }

    send({ type: "pull", keys: keys.map((k) => ({ key: k, since: sinceByKey.get(k) ?? 0 })) });
  }

  private handleMessage(msg: any, keys: string[], epId: string): void {
    if (msg.type === "snapshot") {
      this.applySnapshot(msg, keys).catch(console.error);
    } else if (msg.type === "entity") {
      this.mergeEntity(msg.entity_type as EntityType, msg.data).catch(console.error);
    } else if (msg.type === "deleted") {
      this.applyTombstone(msg.entity_type, msg.entity_id, msg.deleted_at).catch(console.error);
    } else if (msg.type === "user_key_added") {
      // A sibling connection for this same user associated a key, either a new
      // board group or a name set on one. Adopt it the same way ok.user_keys
      // is adopted, which cascades into pulling its data normally. The
      // reporting server is this connection's own server_id.
      this.adoptUserKeys([{ key: msg.key, name: msg.name ?? null }], this.readyServerId.get(epId) ?? null);
    } else if (msg.type === "user_key_removed") {
      removeKeyLocal(msg.key).catch(console.error);
    } else if (msg.type === "grant_info" || msg.type === "grant_created" || msg.type === "clients" || msg.type === "display_name_set") {
      // The server is authoritative for the stored name, so record it before
      // notifying anyone. Otherwise server_identity keeps the value from
      // before the save until the next handshake, and any UI that re-derives
      // its input from server_identity snaps back to the old name right after
      // saving.
      if (msg.type === "display_name_set") {
        this.updateServerIdentityDisplayName(this.readyServerId.get(epId) ?? null, msg.display_name ?? null);
      }
      for (const listener of this.grantReplyListeners.get(epId) ?? []) listener(msg);
    } else if (msg.type === "error") {
      // A grant-operation failure reaches here rather than closing the
      // connection; see EndpointConnection's GRANT_FAILURE_REASONS check.
      // Forward it to whichever UI is waiting on this endpoint. Anything else,
      // including a failure with no listener registered, just logs.
      const reason = typeof msg.reason === "string" ? msg.reason : undefined;
      if (reason && GRANT_FAILURE_REASONS.has(reason) && this.grantReplyListeners.has(epId)) {
        for (const listener of this.grantReplyListeners.get(epId) ?? []) listener(msg);
      } else {
        console.error("Sync error:", msg.message);
      }
    }
  }

  private async applySnapshot(msg: any, keys: string[]): Promise<void> {
    await this.mergeEntityBatch("board", msg.boards ?? []);
    await this.mergeEntityBatch("list", msg.lists ?? []);
    await this.mergeEntityBatch("item", msg.items ?? []);
    await this.mergeAssetBatch(msg.assets ?? []);
    await this.mergeIntegrationResultBatch(msg.integration_results ?? []);
    await this.applyTombstoneBatch(msg.tombstones ?? []);

    // Update per-key timestamps
    const now = msg.server_time as number | undefined;
    if (msg.server_times && typeof msg.server_times === "object") {
      for (const [key, time] of Object.entries(msg.server_times)) {
        if (typeof time === "number") {
          await db.key_sync_state.put({ key, last_sync_at: time });
        }
      }
    } else if (now) {
      // Backward compat: the server sent a single server_time. Apply it to the
      // keys this connection pulled, its own scoped list, rather than every
      // key this client knows about.
      for (const key of keys) {
        await db.key_sync_state.put({ key, last_sync_at: now });
      }
    }

    void import("../db/operations.js").then((m) => m.healLegacyItems()).catch(console.error);
  }

  private async mergeEntityBatch(entityType: "board" | "list" | "item", incoming: any[]): Promise<void> {
    if (!incoming.length) return;
    const table = entityType === "board" ? db.boards : entityType === "list" ? db.lists : db.items;
    const existing = await (table as any).bulkGet(incoming.map((e: any) => e.id));
    const toStore = incoming.map((e: any, i: number) => applyIncomingEntity(entityType, e, existing[i])).filter(Boolean);
    if (toStore.length) await (table as any).bulkPut(toStore);

    // Update routing caches from incoming data
    if (entityType === "list") {
      for (const list of incoming) this.listBoardMap.set(list.id, list.board_id);
    }
    if (entityType === "item") {
      for (const item of incoming) this.itemListMap.set(item.id, item.list_id);
    }
  }

  private async mergeIntegrationResultBatch(incoming: any[]): Promise<void> {
    if (!incoming.length) return;
    const existing = await db.integration_results.bulkGet(incoming.map((e: any) => e.id));
    const toStore = incoming.filter((e: any, i: number) => {
      const ex = existing[i];
      return !ex || (e.updated_at as number) > (ex.updated_at as number);
    });
    if (toStore.length) await db.integration_results.bulkPut(toStore);
  }

  private async mergeAssetBatch(incoming: any[]): Promise<void> {
    if (!incoming.length) return;
    const existing = await db.assets.bulkGet(incoming.map((e: any) => e.id));
    const toStore: ReturnType<typeof assetFromSync>[] = [];
    for (let i = 0; i < incoming.length; i++) {
      const merged = applyIncomingEntity("asset", incoming[i], existing[i] as any);
      if (merged) {
        const asset = assetFromSync(merged as Record<string, unknown>);
        toStore.push(asset);
        registerAsset(asset).catch(console.error);
      }
    }
    if (toStore.length) await db.assets.bulkPut(toStore);
  }

  private async applyTombstoneBatch(tombstones: any[]): Promise<void> {
    if (!tombstones.length) return;
    await db.tombstones.bulkPut(
      tombstones.map((t: any) => ({
        id: `${t.entity_type}:${t.entity_id}`,
        entity_type: t.entity_type,
        entity_id: t.entity_id,
        deleted_at: t.deleted_at,
      })),
    );
    const groups = new Map<string, { id: string; deleted_at: number }[]>();
    for (const t of tombstones) {
      if (!groups.has(t.entity_type)) groups.set(t.entity_type, []);
      groups.get(t.entity_type)!.push({ id: t.entity_id, deleted_at: t.deleted_at });
    }
    for (const [entityType, entries] of groups) {
      const table = entityType === "board" ? db.boards : entityType === "list" ? db.lists : entityType === "item" ? db.items : null;
      if (!table) continue;
      const existing = await (table as any).bulkGet(entries.map((e) => e.id));
      const toDelete = entries.filter((e, i) => shouldDeleteOnTombstone(existing[i], e.deleted_at)).map((e) => e.id);
      if (toDelete.length) await (table as any).bulkDelete(toDelete);
    }
  }

  private async mergeEntity(entityType: EntityType, incoming: any): Promise<void> {
    if (entityType === "integration_result") {
      const existing = await db.integration_results.get(incoming.id);
      if (!existing || (incoming.updated_at as number) > existing.updated_at) {
        await db.integration_results.put(incoming);
      }
      return;
    }
    if (entityType === "asset") {
      const existing = await db.assets.get(incoming.id);
      const toStore = applyIncomingEntity(entityType, incoming, existing as any);
      if (toStore) {
        const asset = assetFromSync(toStore as Record<string, unknown>);
        await db.assets.put(asset);
        registerAsset(asset).catch(console.error);
      }
      return;
    }
    const table = entityType === "board" ? db.boards : entityType === "list" ? db.lists : db.items;
    const existing = await (table as any).get(incoming.id);
    const toStore = applyIncomingEntity(entityType, incoming, existing);
    if (toStore) {
      await (table as any).put(toStore);
      if (entityType === "list") this.listBoardMap.set(incoming.id, incoming.board_id);
      if (entityType === "item") this.itemListMap.set(incoming.id, incoming.list_id);
    }
  }

  private async applyTombstone(entityType: string, entityId: string, deletedAt: number): Promise<void> {
    await db.tombstones.put({
      id: `${entityType}:${entityId}`,
      entity_type: entityType,
      entity_id: entityId,
      deleted_at: deletedAt,
    });
    const table = entityType === "board" ? db.boards : entityType === "list" ? db.lists : entityType === "item" ? db.items : null;
    if (table) {
      const existing = await (table as any).get(entityId);
      if (shouldDeleteOnTombstone(existing, deletedAt)) await (table as any).delete(entityId);
    }
  }
}

export const syncClient = new SyncClient();
