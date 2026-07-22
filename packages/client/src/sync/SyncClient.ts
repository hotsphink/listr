import { db } from "../db/database.js";
import type { Board, List } from "@listr/shared";
import { PROTOCOL_VERSION } from "./protocol.js";
import { setSyncStatus, setSyncStatusMessage } from "./syncStore.js";
import { applyIncomingEntity, shouldDeleteOnTombstone, type EntityType } from "./mergeLogic.js";
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

interface EndpointCallbacks {
  onStatus: (status: EndpointStatus) => void;
  onReady: (send: (msg: unknown) => void, serverId: string) => void;
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
        ws.send(JSON.stringify({ type: "hello", keys: this.keys, client_id: this.clientId, protocol_version: PROTOCOL_VERSION }));
      });

      ws.addEventListener("message", (e: MessageEvent) => {
        let msg: any;
        try { msg = JSON.parse(e.data as string); } catch { return; }

        if (msg.type === "ok") {
          const serverId = typeof msg.server_id === "string" ? msg.server_id : "";
          const known = this.config.lastServerId;
          if (known && serverId && serverId !== known) {
            this.setPhase({ phase: "conflict", knownId: known, newId: serverId });
            return;
          }
          this.setPhase({ phase: "ready", serverId });
          const send = (m: unknown) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
          };
          this.callbacks.onReady(send, serverId);
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

class SyncClient {
  private connections = new Map<string, EndpointConnection>();
  private senders = new Map<string, (msg: unknown) => void>();
  private statusPhases = new Map<string, EndpointPhase>();
  private currentEndpoints: SyncEndpointConfig[] = [];
  private defaultKey = "";
  private allKeys: string[] = []; // defaultKey + distinct board sync_keys
  private clientId = "";

  // Entity routing caches — populated from board/list subscriptions and pushes
  private boardSyncKeys = new Map<string, string>(); // boardId → sync_key (only boards with custom key)
  private listBoardMap = new Map<string, string>(); // listId → boardId
  private itemListMap = new Map<string, string>(); // itemId → listId
  private explicitSharedKeys: string[] = []; // keys added via QR share, independent of boards

  setCredentials(key: string, clientId: string): void {
    if (key === this.defaultKey && clientId === this.clientId) return;
    this.defaultKey = key;
    this.clientId = clientId;
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever the boards table changes. */
  updateBoardKeys(boards: Board[]): void {
    this.boardSyncKeys.clear();
    for (const board of boards) {
      if (board.sync_key) this.boardSyncKeys.set(board.id, board.sync_key);
    }
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever shared_keys table changes. */
  updateSharedKeys(keys: string[]): void {
    this.explicitSharedKeys = keys;
    this.recomputeAllKeys();
  }

  /** Called reactively from App.tsx whenever the lists table changes. */
  updateListBoards(lists: List[]): void {
    this.listBoardMap.clear();
    for (const list of lists) {
      this.listBoardMap.set(list.id, list.board_id);
    }
  }

  setEndpoints(endpoints: SyncEndpointConfig[]): void {
    this.currentEndpoints = endpoints;
    this.applyEndpoints(endpoints);
  }

  async forceFullSync(): Promise<void> {
    await Promise.all([db.boards.clear(), db.lists.clear(), db.items.clear(), db.assets.clear(), db.tombstones.clear()]);
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
    const syncKey = this.effectiveKeyForEntity(entityType, data);
    // Update routing caches so future pushDelete calls can find the key
    if (entityType === "list") this.listBoardMap.set((data as any).id, (data as any).board_id);
    if (entityType === "item") this.itemListMap.set((data as any).id, (data as any).list_id);
    const msg = { type: "push_entity", entity_type: entityType, sync_key: syncKey, data };
    for (const send of this.senders.values()) send(msg);
  }

  pushDelete(entityType: EntityType, entityId: string): void {
    const syncKey = this.effectiveKeyForEntityId(entityType, entityId);
    const deleted_at = Date.now();
    db.tombstones
      .put({ id: `${entityType}:${entityId}`, entity_type: entityType, entity_id: entityId, deleted_at, sync_key: syncKey })
      .catch(console.error);
    const msg = { type: "push_delete", entity_type: entityType, entity_id: entityId, deleted_at, sync_key: syncKey };
    for (const send of this.senders.values()) send(msg);
  }

  private effectiveKeyForEntity(entityType: EntityType, data: any): string {
    if (entityType === "board") return data.sync_key || this.defaultKey;
    if (entityType === "list") {
      const boardId = data.board_id as string;
      return this.boardSyncKeys.get(boardId) ?? this.defaultKey;
    }
    if (entityType === "item") {
      const listId = data.list_id as string;
      const boardId = this.listBoardMap.get(listId);
      return boardId ? (this.boardSyncKeys.get(boardId) ?? this.defaultKey) : this.defaultKey;
    }
    return this.defaultKey; // assets are not namespaced
  }

  private effectiveKeyForEntityId(entityType: EntityType, entityId: string): string {
    if (entityType === "board") return this.boardSyncKeys.get(entityId) ?? this.defaultKey;
    if (entityType === "list") {
      const boardId = this.listBoardMap.get(entityId);
      return boardId ? (this.boardSyncKeys.get(boardId) ?? this.defaultKey) : this.defaultKey;
    }
    if (entityType === "item") {
      const listId = this.itemListMap.get(entityId);
      const boardId = listId ? this.listBoardMap.get(listId) : undefined;
      return boardId ? (this.boardSyncKeys.get(boardId) ?? this.defaultKey) : this.defaultKey;
    }
    return this.defaultKey;
  }

  private recomputeAllKeys(): void {
    if (!this.defaultKey) return;
    const extra = [...new Set([...this.boardSyncKeys.values(), ...this.explicitSharedKeys])];
    const newKeys = [this.defaultKey, ...extra.filter((k) => k !== this.defaultKey)];
    const changed =
      newKeys.length !== this.allKeys.length || newKeys.some((k, i) => k !== this.allKeys[i]);
    if (changed) {
      this.allKeys = newKeys;
      // Restart all connections so they send the updated keys list in hello
      for (const conn of this.connections.values()) conn.stop();
      this.connections.clear();
      this.senders.clear();
      this.statusPhases.clear();
      this.applyEndpoints(this.currentEndpoints);
    }
  }

  private applyEndpoints(endpoints: SyncEndpointConfig[]): void {
    const newIds = new Set(endpoints.map((e) => e.id));

    for (const [id, conn] of this.connections) {
      if (!newIds.has(id)) {
        conn.stop();
        this.connections.delete(id);
        this.senders.delete(id);
        this.statusPhases.delete(id);
        removeEndpointStatus(id);
      }
    }

    for (const ep of endpoints) {
      if (!ep.enabled) {
        if (this.connections.has(ep.id)) {
          this.connections.get(ep.id)!.stop();
          this.connections.delete(ep.id);
          this.senders.delete(ep.id);
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
        this.senders.delete(ep.id);
        this.connections.delete(ep.id);
      }

      this.startConnection(ep);
    }

    this.refreshAggregateStatus();
  }

  private startConnection(ep: SyncEndpointConfig): void {
    const conn = new EndpointConnection(ep, this.allKeys, this.clientId, {
      onStatus: (status) => {
        const wasReady = this.statusPhases.get(ep.id) === "ready";
        if (status.phase !== "ready") {
          this.senders.delete(ep.id);
        }
        this.statusPhases.set(ep.id, status.phase);
        setEndpointStatus(ep.id, status);

        if (status.phase === "ready") {
          for (const [id, c] of this.connections) {
            if (id !== ep.id) c.cancelRetry();
          }
        } else if (wasReady && this.senders.size === 0) {
          for (const [, c] of this.connections) {
            if (c.currentPhase === "error" && !c.hasRetryPending) {
              c.scheduleRetry(5000);
            }
          }
        }

        this.refreshAggregateStatus();
      },
      onReady: (send, serverId) => {
        this.senders.set(ep.id, send);
        db.sync_endpoints.update(ep.id, { last_server_id: serverId }).catch(console.error);
        this.doInitialSync(send).catch(console.error);
        this.refreshAggregateStatus();
      },
      onMessage: (msg) => this.handleMessage(msg),
      onNeedsRetry: () => {
        if (this.senders.size === 0) {
          conn.scheduleRetry(5000);
        }
        this.refreshAggregateStatus();
      },
    });
    this.connections.set(ep.id, conn);
    conn.start();
  }

  private refreshAggregateStatus(): void {
    const phases = [...this.statusPhases.values()].filter((p) => p !== "disabled");
    if (phases.some((p) => p === "ready")) {
      setSyncStatus("connected");
      setSyncStatusMessage("");
    } else if (phases.some((p) => p === "connecting" || p === "handshaking")) {
      setSyncStatus("connecting");
      setSyncStatusMessage("");
    } else if (phases.length > 0 && phases.every((p) => p === "error" || p === "conflict")) {
      setSyncStatus("error");
      setSyncStatusMessage(phases.every((p) => p === "conflict") ? "Server ID conflict" : "Connection failed");
    } else {
      setSyncStatus("disconnected");
      setSyncStatusMessage("");
    }
  }

  private async doInitialSync(send: (msg: unknown) => void): Promise<void> {
    // Fetch per-key since timestamps
    const keyStates = await db.key_sync_state.bulkGet(this.allKeys);
    const sinceByKey = new Map(this.allKeys.map((k, i) => [k, keyStates[i]?.last_sync_at ?? 0]));
    const minSince = Math.min(...[...sinceByKey.values()]);

    // Build board→key and list→board maps for routing
    const boards = await db.boards.where("updated_at").above(minSince).toArray();
    const allBoards = await db.boards.toArray();
    const boardKeyMap = new Map<string, string>(
      allBoards.map((b) => [b.id, b.sync_key || this.defaultKey]),
    );

    const lists = await db.lists.where("updated_at").above(minSince).toArray();
    const allLists = await db.lists.toArray();
    const listBoardId = new Map<string, string>(allLists.map((l) => [l.id, l.board_id]));

    for (const board of boards) {
      const key = board.sync_key || this.defaultKey;
      if (board.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "board", sync_key: key, data: board });
      }
    }

    for (const list of lists) {
      const key = boardKeyMap.get(list.board_id) ?? this.defaultKey;
      if (list.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "list", sync_key: key, data: list });
      }
    }

    const items = await db.items.where("updated_at").above(minSince).toArray();
    for (const item of items) {
      const boardId = listBoardId.get(item.list_id);
      const key = boardId ? (boardKeyMap.get(boardId) ?? this.defaultKey) : this.defaultKey;
      if (item.updated_at > (sinceByKey.get(key) ?? 0)) {
        send({ type: "push_entity", entity_type: "item", sync_key: key, data: item });
        this.itemListMap.set(item.id, item.list_id);
      }
    }

    const assets = await db.assets.where("updated_at").above(minSince).toArray();
    for (const a of assets) {
      send({ type: "push_entity", entity_type: "asset", sync_key: this.defaultKey, data: assetToSync(a) });
    }

    const tombstones = await db.tombstones.where("deleted_at").above(minSince).toArray();
    for (const t of tombstones) {
      const syncKey = t.sync_key ?? this.defaultKey;
      if (t.deleted_at > (sinceByKey.get(syncKey) ?? 0)) {
        send({ type: "push_delete", entity_type: t.entity_type, entity_id: t.entity_id, deleted_at: t.deleted_at, sync_key: syncKey });
      }
    }

    send({ type: "pull", keys: this.allKeys.map((k) => ({ key: k, since: sinceByKey.get(k) ?? 0 })) });
  }

  private handleMessage(msg: any): void {
    if (msg.type === "snapshot") {
      this.applySnapshot(msg).catch(console.error);
    } else if (msg.type === "entity") {
      this.mergeEntity(msg.entity_type as EntityType, msg.data).catch(console.error);
    } else if (msg.type === "deleted") {
      this.applyTombstone(msg.entity_type, msg.entity_id, msg.deleted_at).catch(console.error);
    } else if (msg.type === "error") {
      console.error("Sync error:", msg.message);
    }
  }

  private async applySnapshot(msg: any): Promise<void> {
    await this.mergeEntityBatch("board", msg.boards ?? []);
    await this.mergeEntityBatch("list", msg.lists ?? []);
    await this.mergeEntityBatch("item", msg.items ?? []);
    await this.mergeAssetBatch(msg.assets ?? []);
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
      // Backward compat: server sent a single server_time; apply to all keys
      for (const key of this.allKeys) {
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
