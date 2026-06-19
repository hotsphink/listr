import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince, getServerId } from "./db.js";
import type { EntityType } from "./db.js";
import { config } from "./config.js";
import { extractFromImage } from "./gemini.js";

const PORT = 10_000;
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../certs");
const SERVER_ID = getServerId();

async function handleImport(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.gemini) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gemini API key not configured on server" }));
    return;
  }
  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
  const { image, mime_type, scope } = JSON.parse(body);
  const imageKB = Math.round(image.length * 0.75 / 1024);
  console.log(`[import] ${new Date().toISOString()} scope=${scope.type} model=${config.gemini_model ?? "gemini-2.0-flash-lite"} image=${imageKB}KB`);
  const t0 = Date.now();
  const result = await extractFromImage(image, mime_type, scope, config.gemini, config.gemini_model);
  console.log(`[import] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${result.categories?.length ?? 0} categories`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

const ALLOWED_ORIGINS = new Set([
  "https://hotsphink.github.io",
  "https://finkripper.heron-moth.ts.net:10000",
  "http://localhost:3000",
  "https://localhost:3000",
]);

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

const httpServer = createServer(
  {
    key: readFileSync(join(CERT_DIR, "tailscale.key")),
    cert: readFileSync(join(CERT_DIR, "tailscale.crt")),
  },
  (req, res) => {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET" && req.url === "/api/models") {
      if (!config.gemini) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No API key" })); return; }
      (async () => {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${config.gemini}`);
        const data = await r.json();
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })().catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(err) })); });
      return;
    }
    if (req.method === "POST" && req.url === "/api/import") {
      handleImport(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
      return;
    }
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
      ws.send(JSON.stringify({ type: "ok", server_id: SERVER_ID }));
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
        assets: getEntitiesSince("asset", key, since),
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
