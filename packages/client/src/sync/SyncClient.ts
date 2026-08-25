import { db } from "../db/database.js";
import { removeKeyLocal } from "../db/keyCleanup.js";
import type { Board, List } from "@listr/shared";
import { PROTOCOL_VERSION } from "./protocol.js";
import { setSyncStatus, setSyncStatusMessage } from "./syncStore.js";
import { applyIncomingEntity, shouldDeleteOnTombstone, type EntityType } from "./mergeLogic.js";
import { variantAllowed } from "./variantGuard.js";
import { keysForEndpoint, type ScopedKeyRow } from "./keyScoping.js";
import { connectionsForPush, type PushRoutingConnection } from "./pushRouting.js";
import { assetToSync, assetFromSync, registerAsset } from "./assetStore.js";
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

interface EndpointCallbacks {
  onStatus: (status: EndpointStatus) => void;
  onReady: (send: (msg: unknown) => void, serverId: string, userKeys: ServerUserKey[]) => void;
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

  constructor(
    config: SyncEndpointConfig,
    private keys: string[],
    private clientId: string,
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

  /** The scoped key list this connection actually sent in `hello` (§3.3.1) — read back by SyncClient when it needs the same list later, e.g. for a promoted-standby's initial sync. */
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
    if (!this.keys.length || !this.keys[0]) {
      this.setPhase({ phase: "error", message: "No sync key configured" });
      return;
    }
    const proto = secure ? "wss" : "ws";
    const url = `${proto}://${host}:${port}/sync`;
    this.setPhase({ phase: "connecting" });

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
        ws.send(JSON.stringify({ type: "hello", keys: this.keys, default_key: this.keys[0], client_id: this.clientId, protocol_version: PROTOCOL_VERSION }));
      });

      ws.addEventListener("message", (e: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(e.data as string); } catch { return; }

        if (msg.type === "ok") {
          const serverId = typeof msg.server_id === "string" ? msg.server_id : "";

          // Dev/prod variant guard (§3.3): a server that reports no variant
          // is an older server that predates this field — treated as unknown
          // and allowed (with a warning) so a new client can still talk to a
          // not-yet-updated server. PROTOCOL_VERSION is deliberately not
          // bumped for this.
          const serverVariant = typeof msg.variant === "string" ? msg.variant : undefined;
          if (serverVariant === undefined) {
            console.warn(`[sync] ${this.config.host}:${this.config.port} did not report a variant (older server) — allowing connection`);
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
          this.setPhase({ phase: "ready", serverId });
          const send = (m: unknown) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
          };
          const userKeys: ServerUserKey[] = Array.isArray(msg.user_keys) ? msg.user_keys : [];
          this.callbacks.onReady(send, serverId, userKeys);
          return;
        }

        if (msg.type === "error" && this.currentPhase === "handshaking") {
          this.setPhase({ phase: "error", message: msg.message ?? "Server rejected connection" });
          ws.close();
          return;
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

  private setPhase(status: EndpointStatus): void {
    this.currentPhase = status.phase;
    this.callbacks.onStatus(status);
  }
}

// One primary connection's outgoing plumbing plus everything pushEntity /
// pushDelete / associateKey / leaveKey need to build a message *for that
// connection specifically* (§3.3.1) — `send`, the scoped `keys` list this
// connection actually offered in `hello`, its resolved home key, and the
// server_id it's bound to (for the board-binding exclusion). One primary per
// distinct server_id (claimOrDefer already collapses multiple endpoints on
// the same server down to one), keyed by endpoint id.
interface PrimaryConnection {
  send: (msg: unknown) => void;
  keys: string[];
  homeKeyForServer: string;
  serverId: string;
}

class SyncClient {
  private connections = new Map<string, EndpointConnection>();
  // Only the primary endpoint per distinct server_id — used for outgoing push.
  private primaries = new Map<string, PrimaryConnection>();
  // Every ready connection regardless of primary/standby role, so a standby
  // can be promoted to primary without reconnecting when the primary drops.
  private allSenders = new Map<string, (msg: unknown) => void>();
  private readyServerId = new Map<string, string>(); // endpoint id -> server_id, while ready
  private primaryForServerId = new Map<string, string>(); // server_id -> primary endpoint id
  // endpoint id -> the resolved per-server home key that connection actually
  // used (§3.3.1 item 1) — read back when promoting a standby to primary
  // (releasePrimaryIfHeld) so it can build that connection's PrimaryConnection
  // without re-resolving. Covers every ready connection, primary or standby;
  // `primaries` above only covers the ones actually pushing.
  private resolvedHomeKeyByEndpoint = new Map<string, string>();
  private statusPhases = new Map<string, EndpointPhase>();
  private currentEndpoints: SyncEndpointConfig[] = [];
  // The user-typed secret (sync_config.sync_key): this client's home key,
  // the same on every server it talks to. Per-server derived home keys were
  // built and then removed — see resolveConnectionKeys for why, and Phase 1
  // for where they belong instead. Used directly (not per-connection) only
  // for the one thing that isn't per-connection: the sync_key stamped on a
  // locally-written tombstone row (see pushDelete's comment for why that's a
  // known Phase 1 gap, not fixed here).
  private homeKey = "";
  private clientId = "";
  // Signature of the inputs to keysForEndpoint, used only to skip a
  // reconnect-all when recomputeAllKeys is triggered by a no-op change (e.g.
  // a liveQuery re-firing with equivalent data). Not itself a key list —
  // each endpoint computes its own scoped list at connect time.
  private lastKeysSignature = "";

  // Entity routing caches — populated from board/list subscriptions and pushes
  private boardSyncKeys = new Map<string, string>(); // boardId → sync_key (only boards with custom key)
  private allBoardIds = new Set<string>(); // every local board id, custom-keyed or not — for bindUnboundBoards
  private listBoardMap = new Map<string, string>(); // listId → boardId
  private itemListMap = new Map<string, string>(); // itemId → listId
  // Keys added via QR share or learned from the server (ok.user_keys),
  // independent of local boards — see keyScoping.ts for how server_id scopes
  // which endpoints each one is offered to.
  private sharedKeyRoster: ScopedKeyRow[] = [];
  // Local-only board→server binding (§3.3.1 item 4). boardId -> server_id,
  // or absent/null for "not yet placed" — see database.ts's
  // BoardServerBinding and keyScoping.ts's null-means-unscoped convention.
  private boardServerBinding = new Map<string, string | null>();

  setCredentials(key: string, clientId: string): void {
    if (key === this.homeKey && clientId === this.clientId) return;
    this.homeKey = key;
    this.clientId = clientId;
    this.recomputeAllKeys();
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

  /** Called reactively from App.tsx whenever the board_server_binding table changes (§3.3.1 item 4). */
  updateBoardBindings(rows: { board_id: string; server_id: string | null }[]): void {
    this.boardServerBinding.clear();
    for (const r of rows) this.boardServerBinding.set(r.board_id, r.server_id ?? null);
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
   * newly created board to "the" server it belongs to (§3.3.1 item 4, second
   * bullet: "a board created while a server is primary binds to that
   * server"). If more than one distinct server is simultaneously primary
   * (the non-goal multi-server case — see PrimaryConnection's doc comment),
   * this arbitrarily returns one of them rather than guessing; a board is
   * only ever placed once and can be moved later like any other resync.
   */
  getPrimaryServerId(): string | null {
    return [...this.primaryForServerId.keys()][0] ?? null;
  }

  setEndpoints(endpoints: SyncEndpointConfig[]): void {
    this.currentEndpoints = endpoints;
    this.applyEndpoints(endpoints);
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
    // The local tombstone row carries a single sync_key (this.homeKey as the
    // fallback), even though per-connection routing below may resolve a
    // different key per connection once home keys are server-assigned
    // (Phase 1). Today homeKey is the same everywhere so it doesn't matter;
    // once it isn't, a tombstone needs a key *per server*, not one column —
    // a real Phase 1 issue, not solved here.
    const syncKey = this.effectiveKeyForEntityId(entityType, entityId, this.homeKey);
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

  /** Tell the server this key belongs to the current user (default key), optionally naming it (e.g. a board group). Best-effort. Sent per connection, using that connection's own home key and scoped key list (§3.3.1) — mirrors the board_groups reassertion doInitialSync does on every reconnect. */
  associateKey(key: string, name?: string): void {
    if (!key) return;
    for (const conn of this.primaries.values()) {
      if (key === conn.homeKeyForServer || !conn.keys.includes(key)) continue;
      conn.send({ type: "associate_key", default_key: conn.homeKeyForServer, key, name: name ?? null });
    }
  }

  /** Tell the server to forget this key's association with the current user. Best-effort. Sent per connection — see associateKey. */
  leaveKey(key: string): void {
    if (!key) return;
    for (const conn of this.primaries.values()) {
      if (key === conn.homeKeyForServer || !conn.keys.includes(key)) continue;
      conn.send({ type: "leave_key", default_key: conn.homeKeyForServer, key });
    }
  }

  /**
   * Fold keys the server says belong to this user into local state so their
   * boards/lists/items sync down, reusing the existing shared_keys pipeline
   * (App.tsx's liveQuery → updateSharedKeys → recomputeAllKeys → reconnect).
   *
   * `serverId` is the server that told us about these keys (its `ok.user_keys`
   * echoes back everything we sent it in `hello`, plus any it already knew).
   * That's a direct signal the key belongs there, so this is also where a
   * still-unscoped roster row gets tagged (§3.3.1) — but only if it's still
   * unscoped: a key another server already claimed is left alone, so two
   * endpoints racing their first connect can't fight over who owns it.
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

  // `homeKey` is a parameter, not `this.homeKey`/currentHomeKey, so callers
  // can resolve the same entity's key differently per connection (§3.3.1) —
  // today every connection's homeKeyForServer is equal, so it's a no-op, but
  // this is the seam Phase 1 needs when that stops being true.
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

  // The board id an entity belongs to, for the board-binding exclusion
  // (§3.3.1 item 4) — separate from effectiveKeyForEntity because an unkeyed
  // board (no custom sync_key, so its entities fall back to the home key)
  // still has a binding that must be respected; a home-keyed board's key
  // alone can't signal that (see pushRouting.ts's doc comment). null means
  // "not board-scoped at all" (assets) — never excluded.
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

  // Every distinct custom sync_key among local boards, tagged with the
  // binding of the board(s) that use it (§3.3.1 items 4/5). If two boards
  // sharing a group key somehow disagree on which server they're bound to,
  // fall back to unscoped (null) rather than guess — the safe direction,
  // since unscoped means "offer to every endpoint" (today's behavior),
  // not "offer to none".
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

  // Restarts every connection so each recomputes its own scoped key list
  // (keysForEndpoint) and resends it in hello — the key list is now a
  // function of the endpoint (its resolved server_id and this device's
  // per-server home key), not one flat array, so it can't be diffed as a
  // single before/after list the way it used to be. Guarded by a signature
  // of the (synchronous) inputs so an unrelated liveQuery re-fire with
  // equivalent data doesn't churn every connection. The home key is part of
  // that signature because changing it changes every connection's key list.
  private recomputeAllKeys(): void {
    if (!this.homeKey) return;
    const boardRows = this.boardKeyRows().map((r) => `${r.key}:${r.server_id ?? ""}`).sort();
    const roster = this.sharedKeyRoster.map((r) => `${r.key}:${r.server_id ?? ""}`).sort();
    const signature = JSON.stringify([this.homeKey, boardRows, roster]);
    if (signature === this.lastKeysSignature) return;
    this.lastKeysSignature = signature;

    for (const conn of this.connections.values()) conn.stop();
    this.connections.clear();
    this.primaries.clear();
    this.allSenders.clear();
    this.readyServerId.clear();
    this.primaryForServerId.clear();
    this.resolvedHomeKeyByEndpoint.clear();
    this.statusPhases.clear();
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

  // Resolves this connection's server_id and the keys to offer it (§3.3.1).
  // server_id comes from trust-on-first-use (`sync_endpoints.last_server_id`)
  // and is null for an endpoint never connected to before — keysForEndpoint
  // then offers only still-unscoped rows, which is what makes a brand-new
  // endpoint safe without knowing its identity yet.
  //
  // The home key is the same on every server. Per-server *derived* home keys
  // were built here and then deliberately removed: grandfathering could only
  // be judged from this device's local Dexie, so a device added later would
  // derive a different key than its siblings and silently fail to converge on
  // a server they already share. Deferred to Phase 1, where the server hands
  // an authenticated client its keys via `ok.user_keys` and no such split is
  // possible. Board binding, not key derivation, is what keeps a board from
  // reaching a server it does not belong to.
  private resolveConnectionKeys(ep: SyncEndpointConfig): {
    keys: string[];
    serverId: string | null;
    homeKeyUsed: string;
  } {
    const serverId = ep.lastServerId;
    const homeKeyUsed = this.homeKey;
    const keys = keysForEndpoint(homeKeyUsed, this.boardKeyRows(), this.sharedKeyRoster, serverId);
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
    const conn = new EndpointConnection(ep, resolved.keys, this.clientId, {
      onStatus: (status) => {
        const wasReady = this.statusPhases.get(ep.id) === "ready";
        if (status.phase !== "ready") {
          this.primaries.delete(ep.id);
          this.allSenders.delete(ep.id);
          this.releasePrimaryIfHeld(ep.id);
        }
        this.statusPhases.set(ep.id, status.phase);
        setEndpointStatus(ep.id, status);

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
      onReady: (send, serverId, userKeys) => {
        this.allSenders.set(ep.id, send);
        db.sync_endpoints.update(ep.id, { last_server_id: serverId }).catch(console.error);

        this.adoptUserKeys(userKeys, serverId);
        this.bindUnboundBoards(serverId);
        this.claimOrDefer(ep.id, serverId, send, resolved.keys, resolved.homeKeyUsed);
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

  // Every local board with no binding yet (§3.3.1 item 4: "unbound means not
  // yet placed") gets bound to the server that just successfully connected.
  // Idempotent and cheap once a user's boards are all placed — after the
  // first bind this is a no-op on every subsequent connect.
  private bindUnboundBoards(serverId: string): void {
    for (const boardId of this.allBoardIds) {
      if ((this.boardServerBinding.get(boardId) ?? null) !== null) continue;
      this.boardServerBinding.set(boardId, serverId);
      db.board_server_binding.put({ board_id: boardId, server_id: serverId }).catch(console.error);
    }
  }

  // Two connections landing on the same server_id are almost always the same
  // physical server reached by two different routes (e.g. tailnet + public
  // proxy). Only one of them — whichever finishes its handshake first, which
  // in practice tracks the lower-latency path — pushes/pulls; the other stays
  // connected as a hot standby so it can take over instantly if the primary
  // drops, without duplicating outgoing traffic to the same server meanwhile.
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
      this.primaryForServerId.set(serverId, otherId);
      this.primaries.set(otherId, { send, keys: otherConn.helloKeys, homeKeyForServer: otherHomeKey, serverId });
      setEndpointStatus(otherId, { phase: "ready", serverId, primary: true });
      this.doInitialSync(send, otherConn.helloKeys, serverId, otherHomeKey).catch(console.error);
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
    // Whether this one connection (§3.3.1) should receive an entity keyed
    // `key` whose board is bound to `boardBinding` — the exact same decision
    // pushEntity/pushDelete make for the live path, via the same
    // `connectionsForPush` (see pushRouting.ts for why both the binding
    // check and the `keys.includes` check are needed). Unbound (null)
    // boards are never excluded; bindUnboundBoards (called just before
    // doInitialSync, in onReady) has already placed any that were still
    // unbound as of this connection.
    const reachesThisConnection = (boardBinding: string | null, key: string): boolean =>
      connectionsForPush(boardBinding, [{ epId: "self", serverId, keys, key }]).length > 0;

    // Re-assert every locally-known board group's name on each (re)connect,
    // scoped to the keys this connection actually has (§3.3.1) — a group
    // key withheld from this endpoint's hello must not be associated with it
    // here either, or the scoping above would be pointless. Sent directly
    // via this connection's own `send` rather than the associateKey() helper
    // (which, though per-connection itself now, iterates every primary), so
    // one endpoint reconnecting doesn't needlessly re-send to every other
    // already-connected endpoint too. Fire-and-forget and can be dropped
    // (e.g. racing a connection restart); redoing it on every connect
    // (idempotent server-side) makes it eventually consistent instead of a
    // single best-effort attempt.
    const groups = await db.board_groups.toArray();
    for (const g of groups) {
      if (g.key !== homeKeyForServer && keys.includes(g.key)) {
        send({ type: "associate_key", default_key: homeKeyForServer, key: g.key, name: g.name });
      }
    }

    // Fetch per-key since timestamps
    const keyStates = await db.key_sync_state.bulkGet(keys);
    const sinceByKey = new Map(keys.map((k, i) => [k, keyStates[i]?.last_sync_at ?? 0]));
    const minSince = Math.min(...[...sinceByKey.values()]);

    // Build board→key and list→board maps for routing (unfiltered — used to
    // resolve keys/binding, not to decide what to iterate below).
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
    // `sync_key` column — a Phase 1 gap), so there is no binding check here,
    // only the key check: a tombstone whose sync_key isn't in `keys` is
    // withheld, because `sinceByKey.get(syncKey)` would otherwise default to
    // 0 for a key this connection never declared and push it regardless.
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
      // A sibling connection for this same user associated a key (new board
      // group, or a name being set on one) — adopt it the same way we would
      // from ok.user_keys, which cascades into pulling its data normally.
      // This connection's own server_id is the one that told us, per §3.3.1.
      this.adoptUserKeys([{ key: msg.key, name: msg.name ?? null }], this.readyServerId.get(epId) ?? null);
    } else if (msg.type === "user_key_removed") {
      removeKeyLocal(msg.key).catch(console.error);
    } else if (msg.type === "error") {
      console.error("Sync error:", msg.message);
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
      // Backward compat: server sent a single server_time; apply to the keys
      // this connection actually pulled (its own scoped list, not every key
      // this client knows about — see §3.3.1).
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
