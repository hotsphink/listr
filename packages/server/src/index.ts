import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getProductionDb } from "./db.js";
import type { EntityType, createDbApi } from "./db.js";
import { config } from "./config.js";
import type { IntegrationServerConfig } from "./config.js";
import { extractFromImage } from "./gemini.js";
import { MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION } from "./protocol.js";
import { INTEGRATIONS } from "./integrations/index.js";
import { IntegrationRunner } from "./integration-runner.js";
import type { Item } from "@listr/shared";

type DbApi = ReturnType<typeof createDbApi>;

const PORT = config.port ?? 10_000;
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../certs");

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
  "https://listr.aapx.org",
  "https://listr-sync.aapx.org",
  "https://listr-dev.aapx.org",
  "https://finkripper.heron-moth.ts.net",
  "https://finkripper.heron-moth.ts.net:10000",
  "https://finkripper.heron-moth.ts.net:8443",
  "https://finkripper.heron-moth.ts.net:3000",
  "https://finktop.heron-moth.ts.net",
  "https://finkripper.local",
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

const ts = () => new Date().toISOString();
const keyTag = (keys: string[]) => `[${keys.map((k) => k.slice(0, 6)).join("+")}]`;

export interface SyncServerOptions {
  tls?: boolean;
  certDir?: string;
  integrations?: Record<string, IntegrationServerConfig>;
  requestHandler?: (req: IncomingMessage, res: ServerResponse) => void;
}

export interface SyncServerHandle {
  httpServer: ReturnType<typeof createHttpServer>;
  wss: WebSocketServer;
  stop(): void;
}

// Builds one independent sync server instance around a given DbApi — pulled
// out of module scope so tests can start a server against an in-memory db and
// an ephemeral port instead of the production singleton (§14). Kept as a
// single function rather than split further to keep this refactor small.
export function createSyncServer(dbApi: DbApi, opts: SyncServerOptions = {}): SyncServerHandle {
  const SERVER_ID = dbApi.getServerId();
  const requestHandler = opts.requestHandler ?? ((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Listr sync server running\n");
  });

  const httpServer = opts.tls === false
    ? createHttpServer(requestHandler)
    : createHttpsServer(
        {
          key: readFileSync(join(opts.certDir ?? CERT_DIR, "tailscale.key")),
          cert: readFileSync(join(opts.certDir ?? CERT_DIR, "tailscale.crt")),
        },
        requestHandler,
      );

  const wss = new WebSocketServer({ server: httpServer });

  // sync_key → connected clients (a client may appear under multiple keys)
  const keyToClients = new Map<string, Set<WebSocket>>();

  // home_key ("user") → every currently-open connection presenting that home
  // key, regardless of which other sync_keys it's subscribed to. Used to tell
  // a user's *other* already-open connections about a key they didn't know
  // about yet (or one they should drop), without waiting for their next
  // reconnect — see notifyUserKeyChange/notifyUserKeyRemoved below.
  const homeKeyToClients = new Map<string, Set<WebSocket>>();

  function broadcast(syncKey: string, sender: WebSocket | null, msg: unknown): void {
    const clientSet = keyToClients.get(syncKey);
    if (!clientSet) return;
    const json = JSON.stringify(msg);
    for (const ws of clientSet) {
      if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // Tell a user's other open connections a key now belongs to them (new
  // association, or a name being set/changed on one they already had). The
  // client just needs the key (and name) — receiving it is enough to make the
  // client mark that key locally, which cascades through its own
  // recompute-and-reconnect into pulling the key's actual data normally.
  function notifyUserKeyChange(homeKey: string, key: string, name: string | null, sender: WebSocket): void {
    const clients = homeKeyToClients.get(homeKey);
    if (!clients) return;
    const json = JSON.stringify({ type: "user_key_added", key, name });
    for (const client of clients) {
      if (client !== sender && client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  function notifyUserKeyRemoved(homeKey: string, key: string, sender: WebSocket): void {
    const clients = homeKeyToClients.get(homeKey);
    if (!clients) return;
    const json = JSON.stringify({ type: "user_key_removed", key });
    for (const client of clients) {
      if (client !== sender && client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  const integrationRunner = new IntegrationRunner(dbApi, INTEGRATIONS, opts.integrations ?? {}, broadcast);
  integrationRunner.startPeriodicRefresh();

  wss.on("connection", (ws: WebSocket) => {
    let syncKeys: string[] = [];
    let homeKey: string | null = null; // this connection's authenticated identity, once hello arrives
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
        const rawKeys: string[] = Array.isArray(msg.keys) ? msg.keys.filter((k: unknown) => typeof k === "string") : [];
        const validKeys = rawKeys.map((k) => k.trim()).filter(Boolean);
        // Wire field name is `default_key` — unchanged, see protocol.ts v4/v5.
        const helloHomeKey = typeof msg.default_key === "string" ? msg.default_key.trim() : "";

        if (validKeys.length === 0 || !helloHomeKey) {
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

        // Auto-associate every key this client presents (other than its own home
        // key) with its user, so this user's other devices learn about it too.
        // Track which ones are genuinely new so we only notify siblings about
        // those, not every key on every reconnect.
        const knownBefore = new Set(dbApi.getUserKeys(helloHomeKey).map((u) => u.key));
        const newlyAssociated: string[] = [];
        for (const k of validKeys) {
          if (k === helloHomeKey) continue;
          dbApi.associateUserKey(helloHomeKey, k, null);
          if (!knownBefore.has(k)) newlyAssociated.push(k);
        }
        const userKeys = dbApi.getUserKeys(helloHomeKey);
        syncKeys = [...new Set([...validKeys, ...userKeys.map((u) => u.key)])];
        homeKey = helloHomeKey;
        clientId = typeof msg.client_id === "string" ? msg.client_id.replace(/-/g, "").slice(0, 8) : "?";
        connectedAt = Date.now();

        for (const k of syncKeys) {
          if (!keyToClients.has(k)) keyToClients.set(k, new Set());
          keyToClients.get(k)!.add(ws);
        }
        if (!homeKeyToClients.has(helloHomeKey)) homeKeyToClients.set(helloHomeKey, new Set());
        homeKeyToClients.get(helloHomeKey)!.add(ws);
        for (const k of newlyAssociated) notifyUserKeyChange(helloHomeKey, k, null, ws);

        console.log(`[ws] ${ts()} ${keyTag(syncKeys)} connect client=${clientId} protocol=${clientVersion} keys=${syncKeys.length}`);
        ws.send(JSON.stringify({ type: "ok", server_id: SERVER_ID, min_protocol_version: MIN_PROTOCOL_VERSION, max_protocol_version: MAX_PROTOCOL_VERSION, user_keys: userKeys }));
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
        // Assets are many-to-many with sync_key (asset_keys join table), so the
        // same asset can legitimately match more than one requested key — dedupe
        // by id rather than concatenating like the other entity types.
        const assetsById = new Map<string, unknown>();
        const serverTimes: Record<string, number> = {};
        const now = Date.now();

        for (const { key, since } of keysSince) {
          allBoards.push(...dbApi.getEntitiesSince("board", key, since));
          allLists.push(...dbApi.getEntitiesSince("list", key, since));
          allItems.push(...dbApi.getEntitiesSince("item", key, since));
          for (const a of dbApi.getEntitiesSince("asset", key, since) as { id: string }[]) assetsById.set(a.id, a);
          allTombstones.push(...dbApi.getTombstonesSince(key, since));
          allIntegrationResults.push(...dbApi.getIntegrationResultsSince(key, since));
          serverTimes[key] = now;
        }

        const allAssets = [...assetsById.values()];

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
        const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : "";
        if (!data?.id || !syncKey) return;
        if (entityType === "integration_result") {
          // Clients may push integration_results (e.g. to reset status); don't feed back to runner
          const accepted = dbApi.upsertIntegrationResult(data as any);
          if (accepted) broadcast(syncKey, ws, { type: "entity", entity_type: entityType, data });
        } else {
          const { accepted, previous } = dbApi.upsertEntity(entityType, data, syncKey);
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
        const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : "";
        if (!entityId || !deletedAt || !syncKey) return;
        if (dbApi.applyTombstone(entityType, entityId, deletedAt, syncKey)) {
          broadcast(syncKey, ws, { type: "deleted", entity_type: entityType, entity_id: entityId, deleted_at: deletedAt });
          console.log(`[sync] ${ts()} ${keyTag([syncKey])} delete ${entityType} id=${entityId}`);
        }
        return;
      }

      if (msg.type === "associate_key") {
        // Defect 2.1(1) fix: the identity acted on is the connection's own
        // authenticated home key from `hello`, never the message body — a
        // client cannot mutate another user's key set just by naming their
        // home key here. The body field is only used to detect and log the
        // mismatch; it is never trusted.
        const bodyHomeKey = typeof msg.default_key === "string" ? msg.default_key.trim() : "";
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        const name = typeof msg.name === "string" && msg.name ? msg.name : null;
        if (bodyHomeKey && homeKey && bodyHomeKey !== homeKey) {
          console.warn(`[ws] ${ts()} client=${clientId} associate_key: body default_key (${bodyHomeKey.slice(0, 6)}…) != connection identity (${homeKey.slice(0, 6)}…) — using connection identity`);
        }
        if (homeKey && key && key !== homeKey) {
          dbApi.associateUserKey(homeKey, key, name);
          if (!keyToClients.has(key)) keyToClients.set(key, new Set());
          keyToClients.get(key)!.add(ws);
          if (!syncKeys.includes(key)) syncKeys.push(key);
          // Resolve the actual stored name (associateUserKey never clobbers an
          // existing name with null) so siblings learn the real current value.
          const current = dbApi.getUserKeys(homeKey).find((u) => u.key === key);
          notifyUserKeyChange(homeKey, key, current?.name ?? null, ws);
        }
        return;
      }

      if (msg.type === "leave_key") {
        // Same fix as associate_key above: identity comes from the connection,
        // not the message body.
        const bodyHomeKey = typeof msg.default_key === "string" ? msg.default_key.trim() : "";
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        if (bodyHomeKey && homeKey && bodyHomeKey !== homeKey) {
          console.warn(`[ws] ${ts()} client=${clientId} leave_key: body default_key (${bodyHomeKey.slice(0, 6)}…) != connection identity (${homeKey.slice(0, 6)}…) — using connection identity`);
        }
        if (homeKey && key) {
          dbApi.removeUserKey(homeKey, key);
          keyToClients.get(key)?.delete(ws);
          syncKeys = syncKeys.filter((k) => k !== key);
          notifyUserKeyRemoved(homeKey, key, ws);
        }
        return;
      }
    });

    ws.on("close", () => {
      if (homeKey) {
        const set = homeKeyToClients.get(homeKey);
        if (set) {
          set.delete(ws);
          if (set.size === 0) homeKeyToClients.delete(homeKey);
        }
      }
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

  return {
    httpServer,
    wss,
    stop() {
      integrationRunner.stop();
      wss.close();
      httpServer.close();
    },
  };
}

// Production instance — only runs when this module is the entry point (guards
// against side effects such as HTTPS cert reads and PORT binding when index.ts
// is merely imported for its exports, e.g. from tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  const syncServer = createSyncServer(getProductionDb(), {
    tls: config.tls,
    certDir: CERT_DIR,
    integrations: config.integrations,
    requestHandler: handler,
  });

  const proto = config.tls === false ? "ws" : "wss";
  syncServer.httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Listr sync server on port ${PORT} (${config.tls === false ? "http" : "https"})`);
    console.log(`${proto.toUpperCase()}: ${proto}://finkripper.heron-moth.ts.net:${PORT}`);
  });

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      syncServer.stop();
      process.exit(0);
    });
  }
}
