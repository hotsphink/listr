import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getProductionDb } from "./db.js";
import type { EntityType, createDbApi, UserRow } from "./db.js";
import { config } from "./config.js";
import type { IntegrationServerConfig } from "./config.js";
import { extractFromImage } from "./gemini.js";
import { MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION } from "./protocol.js";
import { jwkThumbprint, verifyAuthSignature } from "./authCrypto.js";
import { INTEGRATIONS } from "./integrations/index.js";
import { IntegrationRunner } from "./integration-runner.js";
import type { Item } from "@listr/shared";

// v5 handshake tuning (auth-design.md §4.2). 60s is generous for a
// challenge round trip (including the crypto) while still being short
// enough that a captured nonce is useless shortly after issuance.
const NONCE_TTL_MS = 60_000;

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
  /** Which world this server belongs to (dev/prod/...), advertised in
   * `challenge` so clients can refuse to talk to the wrong one. Defaults to the
   * process config's variant; tests override it directly. */
  variant?: string;
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
  const SERVER_VARIANT = opts.variant ?? config.variant;
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

  // §2.1 defect 3 / §7.3a: the app and sync server are permanently different
  // origins (listr.aapx.org vs listr-sync.aapx.org), so Origin is a
  // meaningful signal here, unlike a same-origin app. ALLOWED_ORIGINS was
  // previously only used to set a CORS header on the HTTP handlers; the
  // WebSocketServer itself had no check at all. A request with no Origin
  // header is allowed through rather than rejected — browsers always send
  // Origin on a cross-origin WS handshake, so an absent header means a
  // non-browser client (the `ws` client this repo's own test harness and
  // any future CLI/native client use), which this check has nothing to say
  // about; it exists to stop an unexpected *browser* origin, not to require
  // one.
  const wss = new WebSocketServer({
    server: httpServer,
    verifyClient: (info, callback) => {
      const origin = info.origin;
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        callback(true);
        return;
      }
      console.warn(`[ws] ${ts()} rejected upgrade from disallowed origin: ${origin}`);
      callback(false, 403, "Origin not allowed");
    },
  });

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
    let homeKey: string | null = null; // this connection's authenticated home key, once ok/needs_grant is resolved
    let userId: string | null = null; // set once this connection is authenticated (post-ok, or post-redeem_grant)
    let clientId: string | null = null; // full RFC 7638 thumbprint, set at hello time (pre-authentication)
    let clientVersion = 0;
    let pubkeyJwk: Record<string, unknown> | null = null; // set at hello time — needed again by redeem_grant
    let declaredKeys: string[] = []; // this connection's hello.keys, held until auth succeeds
    // Single in-flight nonce per connection (§4.2): 128 bits, consumed by the
    // very next `auth` attempt regardless of outcome (single-use), 60s TTL. A
    // per-connection nonce is sufficient for replay resistance across
    // connections: a captured (nonce, sig) pair was signed against *this*
    // connection's nonce, and any other connection (including a reconnect) gets
    // its own fresh one, so the signature simply won't verify there (see
    // authCrypto.ts's verifyAuthSignature and its cross-server-replay test).
    let expectedNonce: string | null = null;
    let nonceExpiresAt = 0;
    let authenticated = false;
    let connectedAt = 0;
    const pushCounts: Partial<Record<string, number>> = {};

    // Finish authenticating this connection as `user`. Shared by the normal
    // auth success path and by a successful redeem_grant, which is exactly the
    // same "now we know who this connection is" event from a different cause
    // (§6/§7.2: a brand-new client redeeming a grant should be able to reach a
    // working `ok` without a second round trip).
    function completeAuthentication(user: UserRow): void {
      // Auto-associate every key this client declared (other than its own home
      // key) with its user, so this user's other devices learn about it too.
      const knownBefore = new Set(dbApi.getUserKeys(user.user_id).map((u) => u.key));
      const newlyAssociated: string[] = [];
      for (const k of declaredKeys) {
        if (k === user.home_key) continue;
        dbApi.associateUserKey(user.user_id, k, null);
        if (!knownBefore.has(k)) newlyAssociated.push(k);
      }
      const userKeys = dbApi.getUserKeys(user.user_id);
      syncKeys = [...new Set([user.home_key, ...declaredKeys, ...userKeys.map((u) => u.key)])];
      homeKey = user.home_key;
      userId = user.user_id;
      authenticated = true;
      connectedAt = Date.now();

      for (const k of syncKeys) {
        if (!keyToClients.has(k)) keyToClients.set(k, new Set());
        keyToClients.get(k)!.add(ws);
      }
      if (!homeKeyToClients.has(user.home_key)) homeKeyToClients.set(user.home_key, new Set());
      homeKeyToClients.get(user.home_key)!.add(ws);
      for (const k of newlyAssociated) notifyUserKeyChange(user.home_key, k, null, ws);

      dbApi.touchClientLastSeen(clientId!, Date.now());
      console.log(`[ws] ${ts()} ${keyTag(syncKeys)} connect client=${clientId!.slice(0, 8)} user=${user.user_id.slice(0, 8)} protocol=${clientVersion} keys=${syncKeys.length}`);
      ws.send(JSON.stringify({
        type: "ok",
        user_id: user.user_id,
        home_key: user.home_key,
        display_name: user.display_name,
        caps: user.caps,
        user_keys: userKeys,
        server_time: Date.now(),
      }));
    }

    ws.on("message", (raw: Buffer) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      // ── hello: version-gate, then issue a challenge (§4.2) ──────────────
      if (msg.type === "hello") {
        clientVersion = typeof msg.protocol_version === "number" ? msg.protocol_version : 0;
        if (clientVersion < MIN_PROTOCOL_VERSION || clientVersion > MAX_PROTOCOL_VERSION) {
          const range = MIN_PROTOCOL_VERSION === MAX_PROTOCOL_VERSION
            ? `${MIN_PROTOCOL_VERSION}`
            : `${MIN_PROTOCOL_VERSION}–${MAX_PROTOCOL_VERSION}`;
          const message = `Unsupported client protocol version ${clientVersion}; server understands ${range}. Please update the client.`;
          console.log(`[ws] ${ts()} reject client=${typeof msg.client_id === "string" ? msg.client_id.slice(0, 8) : "?"} protocol=${clientVersion} (server ${range})`);
          ws.send(JSON.stringify({ type: "error", message, reason: "protocol", min_protocol_version: MIN_PROTOCOL_VERSION, max_protocol_version: MAX_PROTOCOL_VERSION }));
          ws.close(1008, "Unsupported protocol version");
          return;
        }

        const helloClientId = typeof msg.client_id === "string" ? msg.client_id : "";
        const pubkey = msg.pubkey_jwk;
        const rawKeys: string[] = Array.isArray(msg.keys) ? msg.keys.filter((k: unknown) => typeof k === "string") : [];
        const keys = rawKeys.map((k) => k.trim()).filter(Boolean);

        if (!helloClientId || !pubkey || typeof pubkey !== "object") {
          ws.send(JSON.stringify({ type: "error", message: "hello requires client_id and pubkey_jwk", reason: "protocol" }));
          ws.close(1008, "Missing client identity");
          return;
        }

        // Self-consistency check (§4.2), before anything else: client_id
        // must be the thumbprint of the key it claims. This makes signature
        // verification at `auth` time self-contained — the `clients` table
        // row (if any) is consulted only for registration status, never
        // trusted to supply the identity itself.
        jwkThumbprint(pubkey)
          .then((computed) => {
            if (computed !== helloClientId) {
              console.log(`[ws] ${ts()} reject client_id ${helloClientId.slice(0, 8)}… does not match pubkey_jwk thumbprint`);
              ws.send(JSON.stringify({ type: "error", message: "client_id does not match pubkey_jwk", reason: "protocol" }));
              ws.close(1008, "client_id mismatch");
              return;
            }

            clientId = helloClientId;
            pubkeyJwk = pubkey;
            declaredKeys = keys;

            const nonce = randomBytes(16).toString("base64url"); // 128 bits (§4.2)
            expectedNonce = nonce;
            nonceExpiresAt = Date.now() + NONCE_TTL_MS;

            ws.send(JSON.stringify({
              type: "challenge",
              nonce,
              server_id: SERVER_ID,
              // §3.3 decision: variant travels in `challenge`, not `ok`, so a
              // dev/prod mismatch is caught before the client does any
              // crypto at all.
              variant: SERVER_VARIANT,
              min_protocol_version: MIN_PROTOCOL_VERSION,
              max_protocol_version: MAX_PROTOCOL_VERSION,
            }));
          })
          .catch((err) => {
            console.error(`[ws] ${ts()} error computing thumbprint: ${err instanceof Error ? err.message : err}`);
            ws.send(JSON.stringify({ type: "error", message: "Internal error verifying client identity" }));
            ws.close(1011, "Internal error");
          });
        return;
      }

      // ── auth: verify the signed nonce, then ok / needs_grant / error ────
      if (msg.type === "auth") {
        if (!clientId || !pubkeyJwk || !expectedNonce) {
          ws.send(JSON.stringify({ type: "error", message: "No pending challenge", reason: "protocol" }));
          return;
        }
        const nonce = expectedNonce;
        const expired = Date.now() > nonceExpiresAt;
        expectedNonce = null; // single-use: consumed by this attempt regardless of outcome

        if (expired) {
          ws.send(JSON.stringify({ type: "error", message: "Challenge expired", reason: "protocol" }));
          ws.close(1008, "Challenge expired");
          return;
        }

        const sig = typeof msg.sig === "string" ? msg.sig : "";
        const capturedClientId = clientId;
        const capturedPubkey = pubkeyJwk;
        verifyAuthSignature(capturedPubkey, sig, SERVER_ID, nonce, capturedClientId)
          .then((valid) => {
            if (!valid) {
              console.log(`[ws] ${ts()} auth failed client=${capturedClientId.slice(0, 8)}… bad signature`);
              ws.send(JSON.stringify({ type: "error", message: "Invalid signature", reason: "bad_signature" }));
              ws.close(1008, "Invalid signature");
              return;
            }

            const record = dbApi.getUserForClient(capturedClientId);
            if (!record) {
              ws.send(JSON.stringify({ type: "needs_grant" }));
              return;
            }
            if (record.effectiveState !== "active") {
              console.log(`[ws] ${ts()} client=${capturedClientId.slice(0, 8)}… rejected: ${record.effectiveState}`);
              ws.send(JSON.stringify({ type: "error", message: `Account is ${record.effectiveState}`, reason: record.effectiveState }));
              ws.close(1008, record.effectiveState);
              return;
            }
            completeAuthentication(record.user);
          })
          .catch((err) => {
            console.error(`[ws] ${ts()} error verifying signature: ${err instanceof Error ? err.message : err}`);
            ws.send(JSON.stringify({ type: "error", message: "Internal error verifying signature" }));
            ws.close(1011, "Internal error");
          });
        return;
      }

      // ── redeem_grant (§6, §7.2): registration plumbing, no UI here ──────
      // Works whether this connection is still unauthenticated (invite/
      // device/guest — registers a brand-new client) or already
      // authenticated (share — hands one more key to the existing user);
      // db.ts's applyGrantEffect picks whichever of clientId/pubkeyJwk vs.
      // existingUserId a given grant kind actually needs.
      if (msg.type === "redeem_grant") {
        if (!clientId || !pubkeyJwk) {
          ws.send(JSON.stringify({ type: "error", message: "redeem_grant requires a completed challenge/auth first", reason: "protocol" }));
          return;
        }
        const grantId = typeof msg.grant_id === "string" ? msg.grant_id : "";
        const secret = typeof msg.secret === "string" ? msg.secret : "";
        if (!grantId || !secret) {
          ws.send(JSON.stringify({ type: "error", message: "redeem_grant requires grant_id and secret" }));
          return;
        }
        const label = typeof msg.label === "string" && msg.label ? msg.label : null;

        let result: ReturnType<typeof dbApi.redeemGrant>;
        try {
          result = dbApi.redeemGrant(
            grantId,
            secret,
            { clientId, pubkeyJwk: JSON.stringify(pubkeyJwk), label, existingUserId: userId ?? undefined },
            Date.now(),
          );
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }));
          return;
        }
        if (!result.ok) {
          ws.send(JSON.stringify({ type: "error", message: `Grant redemption failed: ${result.reason}`, reason: result.reason }));
          return;
        }
        completeAuthentication(result.result.user);
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated", reason: "protocol" }));
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
        console.log(`[sync] ${ts()} ${keyTag(syncKeys)} client=${clientId?.slice(0, 8)} pull keys=${keysSince.length}${pushed ? ` pushed: ${pushed}` : ""} → boards=${allBoards.length} lists=${allLists.length} items=${allItems.length} assets=${allAssets.length} tombstones=${allTombstones.length} integration_results=${allIntegrationResults.length}`);

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
        // Defect 2.1(1) fix (now structural, not just checked): the identity
        // acted on is always this connection's own authenticated identity
        // (userId/homeKey from the v5 handshake) — there is no client-
        // supplied identity field on this message at all anymore for a
        // client to spoof another user's home key with.
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        const name = typeof msg.name === "string" && msg.name ? msg.name : null;
        if (homeKey && userId && key && key !== homeKey) {
          dbApi.associateUserKey(userId, key, name);
          if (!keyToClients.has(key)) keyToClients.set(key, new Set());
          keyToClients.get(key)!.add(ws);
          if (!syncKeys.includes(key)) syncKeys.push(key);
          // Resolve the actual stored name (associateUserKey never clobbers an
          // existing name with null) so siblings learn the real current value.
          const current = dbApi.getUserKeys(userId).find((u) => u.key === key);
          notifyUserKeyChange(homeKey, key, current?.name ?? null, ws);
        }
        return;
      }

      if (msg.type === "leave_key") {
        // Same fix as associate_key above: identity comes from the
        // connection, and there is no message-body field to spoof it with.
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        if (homeKey && userId && key) {
          dbApi.removeUserKey(userId, key);
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
        console.log(`[ws] ${ts()} ${keyTag(syncKeys)} disconnect after=${secs}s client=${clientId?.slice(0, 8) ?? "?"}`);
      }
    });
    ws.on("error", (err: Error) => console.error(`[ws] ${ts()} ${syncKeys.length ? keyTag(syncKeys) : "[?]"} client=${clientId?.slice(0, 8) ?? "?"} error: ${err.message}`));
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
