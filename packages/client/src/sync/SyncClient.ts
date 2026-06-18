import { db } from "../db/database.js";
import { setSyncStatus, setSyncStatusMessage } from "./syncStore.js";
import { applyIncomingEntity, type EntityType } from "./mergeLogic.js";
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
    private key: string,
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
    const proto = secure ? "wss" : "ws";
    const url = `${proto}://${host}:${port}`;
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
        ws.send(JSON.stringify({ type: "hello", key: this.key, client_id: this.clientId }));
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
  private key = "";
  private clientId = "";

  setCredentials(key: string, clientId: string): void {
    if (key === this.key && clientId === this.clientId) return;
    this.key = key;
    this.clientId = clientId;
    for (const conn of this.connections.values()) conn.stop();
    this.connections.clear();
    this.senders.clear();
    this.statusPhases.clear();
    this.applyEndpoints(this.currentEndpoints);
  }

  setEndpoints(endpoints: SyncEndpointConfig[]): void {
    this.currentEndpoints = endpoints;
    this.applyEndpoints(endpoints);
  }

  pushEntity(entityType: EntityType, data: unknown): void {
    const msg = { type: "push_entity", entity_type: entityType, data };
    for (const send of this.senders.values()) send(msg);
  }

  pushDelete(entityType: EntityType, entityId: string): void {
    const deleted_at = Date.now();
    db.tombstones
      .put({ id: `${entityType}:${entityId}`, entity_type: entityType, entity_id: entityId, deleted_at })
      .catch(console.error);
    const msg = { type: "push_delete", entity_type: entityType, entity_id: entityId, deleted_at };
    for (const send of this.senders.values()) send(msg);
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
    const conn = new EndpointConnection(ep, this.key, this.clientId, {
      onStatus: (status) => {
        const wasReady = this.statusPhases.get(ep.id) === "ready";
        if (status.phase !== "ready") {
          this.senders.delete(ep.id);
        }
        this.statusPhases.set(ep.id, status.phase);
        setEndpointStatus(ep.id, status);

        if (status.phase === "ready") {
          // A server is up — cancel pending retries on all other endpoints
          for (const [id, c] of this.connections) {
            if (id !== ep.id) c.cancelRetry();
          }
        } else if (wasReady && this.senders.size === 0) {
          // Last ready connection dropped — restart retries on all error endpoints
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
        // Only retry if no server is currently reachable
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
    const config = await db.sync_config.get("default");
    const since = config?.last_sync_at ?? 0;

    const [cats, lists, items, assets] = await Promise.all([
      db.categories.where("updated_at").above(since).toArray(),
      db.lists.where("updated_at").above(since).toArray(),
      db.items.where("updated_at").above(since).toArray(),
      db.assets.where("updated_at").above(since).toArray(),
    ]);
    for (const e of cats) send({ type: "push_entity", entity_type: "category", data: e });
    for (const e of lists) send({ type: "push_entity", entity_type: "list", data: e });
    for (const e of items) send({ type: "push_entity", entity_type: "item", data: e });
    for (const a of assets) send({ type: "push_entity", entity_type: "asset", data: assetToSync(a) });

    const tombstones = await db.tombstones.where("deleted_at").above(since).toArray();
    for (const t of tombstones) {
      send({ type: "push_delete", entity_type: t.entity_type, entity_id: t.entity_id, deleted_at: t.deleted_at });
    }

    send({ type: "pull", since });
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
    for (const e of msg.categories ?? []) await this.mergeEntity("category", e);
    for (const e of msg.lists ?? []) await this.mergeEntity("list", e);
    for (const e of msg.items ?? []) await this.mergeEntity("item", e);
    for (const e of msg.assets ?? []) await this.mergeEntity("asset", e);
    for (const t of msg.tombstones ?? []) {
      await this.applyTombstone(t.entity_type, t.entity_id, t.deleted_at);
    }
    if (msg.server_time) {
      await db.sync_config.update("default", { last_sync_at: msg.server_time });
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
    const table = entityType === "category" ? db.categories : entityType === "list" ? db.lists : db.items;
    const existing = await (table as any).get(incoming.id);
    const toStore = applyIncomingEntity(entityType, incoming, existing);
    if (toStore) await (table as any).put(toStore);
  }

  private async applyTombstone(entityType: string, entityId: string, deletedAt: number): Promise<void> {
    await db.tombstones.put({
      id: `${entityType}:${entityId}`,
      entity_type: entityType,
      entity_id: entityId,
      deleted_at: deletedAt,
    });
    if (entityType === "category") await db.categories.delete(entityId);
    else if (entityType === "list") await db.lists.delete(entityId);
    else if (entityType === "item") await db.items.delete(entityId);
  }
}

export const syncClient = new SyncClient();
