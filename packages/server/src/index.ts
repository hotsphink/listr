import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { db, upsertEntity, getEntitiesSince, applyTombstone, getTombstonesSince, getServerId, getIntegrationResultsSince } from "./db.js";
import type { EntityType } from "./db.js";
import { config } from "./config.js";
import { extractFromImage } from "./gemini.js";
import { MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION } from "./protocol.js";
import { INTEGRATIONS } from "./integrations/index.js";
import { IntegrationRunner } from "./integration-runner.js";
import type { Item } from "@listr/shared";

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

// sync_key → connected clients (a client may appear under multiple keys)
const keyToClients = new Map<string, Set<WebSocket>>();

const ts = () => new Date().toISOString();
const keyTag = (keys: string[]) => `[${keys.map((k) => k.slice(0, 6)).join("+")}]`;

function broadcast(syncKey: string, sender: WebSocket | null, msg: unknown): void {
  const clientSet = keyToClients.get(syncKey);
  if (!clientSet) return;
  const json = JSON.stringify(msg);
  for (const ws of clientSet) {
    if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

const integrationRunner = new IntegrationRunner(db, INTEGRATIONS, config.integrations ?? {}, broadcast);
integrationRunner.startPeriodicRefresh();

wss.on("connection", (ws: WebSocket) => {
  let syncKeys: string[] = [];
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
      // Accept `keys` (v3 array) or `key` (v2 string) for backward compatibility
      let rawKeys: string[];
      if (Array.isArray(msg.keys)) {
        rawKeys = msg.keys.filter((k: unknown) => typeof k === "string");
      } else if (typeof msg.key === "string") {
        rawKeys = [msg.key];
      } else {
        rawKeys = [];
      }
      const validKeys = rawKeys.map((k) => k.trim()).filter(Boolean);

      if (validKeys.length === 0) {
        ws.send(JSON.stringify({ type: "error", message: "Missing key" }));
        return;
      }

      const clientVersion = typeof msg.protocol_version === "number" ? msg.protocol_version : 0;
      if (clientVersion < MIN_PROTOCOL_VERSION || clientVersion > MAX_PROTOCOL_VERSION) {
        const range = MIN_PROTOCOL_VERSION === MAX_PROTOCOL_VERSION
          ? `${MIN_PROTOCOL_VERSION}`
          : `${MIN_PROTOCOL_VERSION}–${MAX_PROTOCOL_VERSION}`;
        const message = `Unsupported client protocol version ${clientVersion}; server understands ${range}. Please update the client.`;
        console.log(`[ws] ${ts()} ${keyTag(validKeys)} reject client=${typeof msg.client_id === "string" ? msg.client_id.replace(/-/g, "").slice(0, 8) : "?"} protocol=${clientVersion} (server ${range})`);
        ws.send(JSON.stringify({ type: "error", message, min_protocol_version: MIN_PROTOCOL_VERSION, max_protocol_version: MAX_PROTOCOL_VERSION }));
        ws.close(1008, "Unsupported protocol version");
        return;
      }

      syncKeys = validKeys;
      clientId = typeof msg.client_id === "string" ? msg.client_id.replace(/-/g, "").slice(0, 8) : "?";
      connectedAt = Date.now();

      for (const k of syncKeys) {
        if (!keyToClients.has(k)) keyToClients.set(k, new Set());
        keyToClients.get(k)!.add(ws);
      }

      console.log(`[ws] ${ts()} ${keyTag(syncKeys)} connect client=${clientId} protocol=${clientVersion} keys=${syncKeys.length}`);
      ws.send(JSON.stringify({ type: "ok", server_id: SERVER_ID, min_protocol_version: MIN_PROTOCOL_VERSION, max_protocol_version: MAX_PROTOCOL_VERSION }));
      return;
    }

    if (syncKeys.length === 0) {
      ws.send(JSON.stringify({ type: "error", message: "Send hello first" }));
      return;
    }

    if (msg.type === "pull") {
      // v3: { keys: [{ key, since }] }  — v2 compat: { since } applied to all keys
      let keysSince: Array<{ key: string; since: number }>;
      if (Array.isArray(msg.keys)) {
        keysSince = msg.keys
          .filter((k: any) => typeof k.key === "string" && typeof k.since === "number")
          .map((k: any) => ({ key: k.key as string, since: k.since as number }));
      } else {
        const since: number = typeof msg.since === "number" ? msg.since : 0;
        keysSince = syncKeys.map((k) => ({ key: k, since }));
      }

      const allBoards: unknown[] = [];
      const allLists: unknown[] = [];
      const allItems: unknown[] = [];
      const allTombstones: unknown[] = [];
      const allIntegrationResults: unknown[] = [];
      const serverTimes: Record<string, number> = {};
      const now = Date.now();
      let minSince = Infinity;

      for (const { key, since } of keysSince) {
        allBoards.push(...getEntitiesSince("board", key, since));
        allLists.push(...getEntitiesSince("list", key, since));
        allItems.push(...getEntitiesSince("item", key, since));
        allTombstones.push(...getTombstonesSince(key, since));
        allIntegrationResults.push(...getIntegrationResultsSince(key, since));
        serverTimes[key] = now;
        if (since < minSince) minSince = since;
      }

      const allAssets = getEntitiesSince("asset", "", minSince === Infinity ? 0 : minSince);

      const pushed = Object.entries(pushCounts).map(([k, v]) => `${k}=${v}`).join(" ");
      for (const k of Object.keys(pushCounts)) delete pushCounts[k];
      console.log(`[sync] ${ts()} ${keyTag(syncKeys)} client=${clientId} pull keys=${keysSince.length}${pushed ? ` pushed: ${pushed}` : ""} → boards=${allBoards.length} lists=${allLists.length} items=${allItems.length} assets=${allAssets.length} tombstones=${allTombstones.length} integration_results=${allIntegrationResults.length}`);

      ws.send(JSON.stringify({
        type: "snapshot",
        boards: allBoards,
        lists: allLists,
        items: allItems,
        assets: allAssets,
        tombstones: allTombstones,
        integration_results: allIntegrationResults,
        server_times: serverTimes,
        server_time: now, // backward compat
      }));
      return;
    }

    if (msg.type === "push_entity") {
      const entityType = msg.entity_type as EntityType | "integration_result";
      const data = msg.data as Record<string, unknown>;
      // v3: sync_key on message; v2 compat: use first client key
      const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : syncKeys[0];
      if (!data?.id || !syncKey) return;
      if (entityType === "integration_result") {
        // Clients may push integration_results (e.g. to reset status); don't feed back to runner
        const accepted = db.upsertIntegrationResult(data as any);
        if (accepted) broadcast(syncKey, ws, { type: "entity", entity_type: entityType, data });
      } else {
        const { accepted, previous } = upsertEntity(entityType, data, syncKey);
        if (accepted) {
          broadcast(syncKey, ws, { type: "entity", entity_type: entityType, data });
          if (entityType === "item") {
            integrationRunner.onItemUpserted(data as unknown as Item, previous as unknown as Item | null, syncKey);
          }
        }
      }
      pushCounts[entityType] = (pushCounts[entityType] ?? 0) + 1;
      return;
    }

    if (msg.type === "push_delete") {
      const entityType = msg.entity_type as EntityType;
      const entityId = msg.entity_id as string;
      const deletedAt = msg.deleted_at as number;
      // v3: sync_key on message; v2 compat: use first client key
      const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : syncKeys[0];
      if (!entityId || !deletedAt || !syncKey) return;
      if (applyTombstone(entityType, entityId, deletedAt, syncKey)) {
        broadcast(syncKey, ws, { type: "deleted", entity_type: entityType, entity_id: entityId, deleted_at: deletedAt });
        console.log(`[sync] ${ts()} ${keyTag([syncKey])} delete ${entityType} id=${entityId}`);
      }
      return;
    }
  });

  ws.on("close", () => {
    for (const key of syncKeys) {
      const set = keyToClients.get(key);
      if (set) {
        set.delete(ws);
        if (set.size === 0) keyToClients.delete(key);
      }
    }
    if (syncKeys.length > 0) {
      const secs = Math.round((Date.now() - connectedAt) / 1000);
      console.log(`[ws] ${ts()} ${keyTag(syncKeys)} disconnect after=${secs}s client=${clientId ?? "?"}`);
    }
  });
  ws.on("error", (err: Error) => console.error(`[ws] ${ts()} ${syncKeys.length ? keyTag(syncKeys) : "[?]"} client=${clientId ?? "?"} error: ${err.message}`));
});

const proto = config.tls === false ? "ws" : "wss";
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Listr sync server on port ${PORT} (${config.tls === false ? "http" : "https"})`);
  console.log(`${proto.toUpperCase()}: ${proto}://finkripper.heron-moth.ts.net:${PORT}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    integrationRunner.stop();
    process.exit(0);
  });
}
