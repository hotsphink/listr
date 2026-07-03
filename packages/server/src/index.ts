import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince, getServerId } from "./db.js";
import type { EntityType } from "./db.js";
import { config } from "./config.js";
import { extractFromImage } from "./gemini.js";

const PORT = config.port ?? 10_000;
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
  console.log(`[import] done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${result.boards?.length ?? 0} boards`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(result));
}

const ALLOWED_ORIGINS = new Set([
  "https://hotsphink.github.io",
  "https://listr-sync.aapx.org",
  "https://finkripper.heron-moth.ts.net",
  "https://finkripper.heron-moth.ts.net:10000",
  "https://finkripper.heron-moth.ts.net:8443",
  "https://finkripper.heron-moth.ts.net:3000",
  "https://finktop.heron-moth.ts.net",
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

const handler = (req: IncomingMessage, res: ServerResponse) => {
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
};

const httpServer = config.tls === false
  ? createHttpServer(handler)
  : createHttpsServer(
      {
        key: readFileSync(join(CERT_DIR, "tailscale.key")),
        cert: readFileSync(join(CERT_DIR, "tailscale.crt")),
      },
      handler,
    );

const wss = new WebSocketServer({ server: httpServer });

// sync_key → connected clients
const clients = new Map<string, Set<WebSocket>>();

const ts = () => new Date().toISOString();
const keyTag = (k: string) => `[${k.slice(0, 8)}]`;

function broadcast(syncKey: string, sender: WebSocket, msg: unknown): void {
  const client = clients.get(syncKey);
  if (!client) return;
  const json = JSON.stringify(msg);
  for (const ws of client) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

wss.on("connection", (ws: WebSocket) => {
  let syncKey: string | null = null;
  let clientId: string | null = null;
  let connectedAt = 0;
  const pushCounts: Partial<Record<string, number>> = {};

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
      clientId = typeof msg.client_id === "string" ? msg.client_id.replace(/-/g, "").slice(0, 8) : "?";
      connectedAt = Date.now();
      if (!clients.has(k)) clients.set(k, new Set());
      clients.get(k)!.add(ws);
      console.log(`[ws] ${ts()} ${keyTag(k)} connect client=${clientId}`);
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
      const boards = getEntitiesSince("board", key, since);
      const lists = getEntitiesSince("list", key, since);
      const items = getEntitiesSince("item", key, since);
      const assets = getEntitiesSince("asset", key, since);
      const tombstones = getTombstonesSince(key, since);
      const pushed = Object.entries(pushCounts).map(([k, v]) => `${k}=${v}`).join(" ");
      for (const k of Object.keys(pushCounts)) delete pushCounts[k];
      console.log(`[sync] ${ts()} ${keyTag(key)} client=${clientId} pull since=${since}${pushed ? ` pushed: ${pushed}` : ""} → boards=${boards.length} lists=${lists.length} items=${items.length} assets=${assets.length} tombstones=${tombstones.length}`);
      ws.send(JSON.stringify({ type: "snapshot", boards, lists, items, assets, tombstones, server_time: Date.now() }));
      return;
    }

    if (msg.type === "push_entity") {
      const entityType = msg.entity_type as EntityType;
      const data = msg.data as Record<string, unknown>;
      if (!data?.id) return;
      const accepted = upsertEntity(entityType, data, key);
      if (accepted) broadcast(key, ws, { type: "entity", entity_type: entityType, data });
      pushCounts[entityType] = (pushCounts[entityType] ?? 0) + 1;
      return;
    }

    if (msg.type === "push_delete") {
      const entityType = msg.entity_type as EntityType;
      const entityId = msg.entity_id as string;
      const deletedAt = msg.deleted_at as number;
      if (!entityId || !deletedAt) return;
      if (applyTombstone(entityType, entityId, deletedAt, key)) {
        broadcast(key, ws, { type: "deleted", entity_type: entityType, entity_id: entityId, deleted_at: deletedAt });
        console.log(`[sync] ${ts()} ${keyTag(key)} delete ${entityType} id=${entityId}`);
      }
      return;
    }
  });

  ws.on("close", () => {
    if (syncKey) {
      clients.get(syncKey)?.delete(ws);
      const secs = Math.round((Date.now() - connectedAt) / 1000);
      console.log(`[ws] ${ts()} ${keyTag(syncKey)} disconnect after=${secs}s client=${clientId ?? "?"}`);
    }
  });
  ws.on("error", (err: Error) => console.error(`[ws] ${ts()} ${syncKey ? keyTag(syncKey) : "[?]"} client=${clientId ?? "?"} error: ${err.message}`));
});

const proto = config.tls === false ? "ws" : "wss";
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listr sync server on port ${PORT} (${config.tls === false ? "http" : "https"})`);
  console.log(`${proto.toUpperCase()}: ${proto}://finkripper.heron-moth.ts.net:${PORT}`);
});
