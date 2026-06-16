import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince } from "./db.js";
import type { EntityType } from "./db.js";

const PORT = 10_000;
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../certs");

const httpServer = createServer(
  {
    key: readFileSync(join(CERT_DIR, "tailscale.key")),
    cert: readFileSync(join(CERT_DIR, "tailscale.crt")),
  },
  (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Listr sync server running\n");
  },
);

const wss = new WebSocketServer({ server: httpServer });

// sync_key → connected clients
const rooms = new Map<string, Set<WebSocket>>();

function broadcast(syncKey: string, sender: WebSocket, msg: unknown): void {
  const room = rooms.get(syncKey);
  if (!room) return;
  const json = JSON.stringify(msg);
  for (const ws of room) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

wss.on("connection", (ws: WebSocket) => {
  let syncKey: string | null = null;

  ws.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (msg.type === "hello") {
      const k = typeof msg.key === "string" ? msg.key.trim() : "";
      if (!k) { ws.send(JSON.stringify({ type: "error", message: "Missing key" })); return; }
      syncKey = k;
      if (!rooms.has(k)) rooms.set(k, new Set());
      rooms.get(k)!.add(ws);
      ws.send(JSON.stringify({ type: "ok" }));
      return;
    }

    if (!syncKey) {
      ws.send(JSON.stringify({ type: "error", message: "Send hello first" }));
      return;
    }

    const key = syncKey; // narrow to string for use below

    if (msg.type === "pull") {
      const since: number = typeof msg.since === "number" ? msg.since : 0;
      ws.send(JSON.stringify({
        type: "snapshot",
        categories: getEntitiesSince("category", key, since),
        lists: getEntitiesSince("list", key, since),
        items: getEntitiesSince("item", key, since),
        tombstones: getTombstonesSince(key, since),
        server_time: Date.now(),
      }));
      return;
    }

    if (msg.type === "push_entity") {
      const entityType = msg.entity_type as EntityType;
      const data = msg.data as Record<string, unknown>;
      if (!data?.id) return;
      if (upsertEntity(entityType, data, key)) {
        broadcast(key, ws, { type: "entity", entity_type: entityType, data });
      }
      return;
    }

    if (msg.type === "push_delete") {
      const entityType = msg.entity_type as EntityType;
      const entityId = msg.entity_id as string;
      const deletedAt = msg.deleted_at as number;
      if (!entityId || !deletedAt) return;
      if (applyTombstone(entityType, entityId, deletedAt, key)) {
        broadcast(key, ws, { type: "deleted", entity_type: entityType, entity_id: entityId, deleted_at: deletedAt });
      }
      return;
    }
  });

  ws.on("close", () => { if (syncKey) rooms.get(syncKey)?.delete(ws); });
  ws.on("error", (err: Error) => console.error("WS error:", err.message));
});

// Listen on all interfaces so phone can reach it over LAN
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listr sync server on port ${PORT}`);
  console.log(`WSS: wss://finkripper.heron-moth.ts.net:${PORT}`);
});
