import { db } from "../db/database.js";
import { setSyncStatus, setSyncStatusMessage } from "./syncStore.js";
import { applyIncomingEntity, type EntityType } from "./mergeLogic.js";
import { assetToSync, assetFromSync, registerAsset } from "./assetStore.js";

class SyncClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentUrl = "";
  private currentKey = "";
  private currentClientId = "";

  connect(url: string, key: string, clientId: string): void {
    this.currentUrl = url;
    this.currentKey = key;
    this.currentClientId = clientId;
    this.openSocket();
  }

  disconnect(): void {
    this.currentUrl = "";
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    setSyncStatus("disconnected");
    setSyncStatusMessage("");
  }

  pushEntity(entityType: EntityType, data: unknown): void {
    this.send({ type: "push_entity", entity_type: entityType, data });
  }

  pushDelete(entityType: EntityType, entityId: string): void {
    const deleted_at = Date.now();
    db.tombstones
      .put({ id: `${entityType}:${entityId}`, entity_type: entityType, entity_id: entityId, deleted_at })
      .catch(console.error);
    this.send({ type: "push_delete", entity_type: entityType, entity_id: entityId, deleted_at });
  }

  private openSocket(): void {
    if (!this.currentUrl) return;
    setSyncStatus("connecting");

    try {
      const ws = new WebSocket(this.currentUrl);
      this.ws = ws;

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ type: "hello", key: this.currentKey, client_id: this.currentClientId }));
      });

      ws.addEventListener("message", (event: MessageEvent) => {
        try { this.handleMessage(JSON.parse(event.data as string)); }
        catch (e) { console.error("Sync parse error:", e); }
      });

      ws.addEventListener("close", () => {
        this.ws = null;
        if (this.currentUrl) {
          setSyncStatus("disconnected");
          this.reconnectTimer = setTimeout(() => this.openSocket(), 5000);
        }
      });

      ws.addEventListener("error", () => {
        setSyncStatus("error");
        setSyncStatusMessage("Connection failed");
      });
    } catch (e) {
      setSyncStatus("error");
      setSyncStatusMessage(String(e));
    }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private handleMessage(msg: any): void {
    if (msg.type === "ok") {
      setSyncStatus("connected");
      setSyncStatusMessage("");
      this.doInitialSync().catch(console.error);
      return;
    }
    if (msg.type === "snapshot") {
      this.applySnapshot(msg).catch(console.error);
      return;
    }
    if (msg.type === "entity") {
      this.mergeEntity(msg.entity_type as EntityType, msg.data).catch(console.error);
      return;
    }
    if (msg.type === "deleted") {
      this.applyTombstone(msg.entity_type, msg.entity_id, msg.deleted_at).catch(console.error);
      return;
    }
    if (msg.type === "error") {
      setSyncStatus("error");
      setSyncStatusMessage(msg.message ?? "Unknown error");
    }
  }

  private async doInitialSync(): Promise<void> {
    const config = await db.sync_config.get("default");
    const since = config?.last_sync_at ?? 0;

    // Push local changes since last sync
    const [cats, lists, items, assets] = await Promise.all([
      db.categories.where("updated_at").above(since).toArray(),
      db.lists.where("updated_at").above(since).toArray(),
      db.items.where("updated_at").above(since).toArray(),
      db.assets.where("updated_at").above(since).toArray(),
    ]);
    for (const e of cats) this.send({ type: "push_entity", entity_type: "category", data: e });
    for (const e of lists) this.send({ type: "push_entity", entity_type: "list", data: e });
    for (const e of items) this.send({ type: "push_entity", entity_type: "item", data: e });
    for (const a of assets) this.send({ type: "push_entity", entity_type: "asset", data: assetToSync(a) });

    const tombstones = await db.tombstones.where("deleted_at").above(since).toArray();
    for (const t of tombstones) {
      this.send({ type: "push_delete", entity_type: t.entity_type, entity_id: t.entity_id, deleted_at: t.deleted_at });
    }

    // Pull server changes since last sync
    this.send({ type: "pull", since });
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
