import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { randomBytes, X509Certificate } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { getProductionDb } from "./db.js";
import type { EntityType, createDbApi, UserRow, Cap, GrantKind } from "./db.js";
import { config } from "./config.js";
import type { ConsoleConfig, IntegrationServerConfig } from "./config.js";
import { extractFromImage } from "./gemini.js";
import { MIN_PROTOCOL_VERSION, MAX_PROTOCOL_VERSION } from "./protocol.js";
import { jwkThumbprint, verifyAuthSignature } from "./authCrypto.js";
import { INTEGRATIONS } from "./integrations/index.js";
import { IntegrationRunner } from "./integration-runner.js";
import type { Board } from "@listr/shared";
import type { IntegrationModule } from "./integrations/types.js";
import type { RunnerOptions } from "./integration-runner.js";
import { Monitor } from "./console-api/monitor.js";
import { ConsoleRouter } from "./console-api/router.js";

// Entity types clients may push or delete.
const SYNCED_ENTITY_TYPES = new Set<string>(["board", "list", "item", "asset"]);

// Handshake tuning. 60s is generous for a challenge round trip, including the
// crypto, while still being short enough that a captured nonce is useless
// shortly after issuance.
const NONCE_TTL_MS = 60_000;

// -- Basic limits ------------------------------------------------------------
// Four cheap, accounting-free limits against casual or accidental DoS, not a
// full quota system. The accidental case is the one that matters most: a
// client bug that pushes in a loop looks exactly like an attack and will
// happily saturate the server on the user's own behalf.
const MAX_WS_PAYLOAD_BYTES = 1 * 1024 * 1024; // ~1MB, so one giant push cannot wedge the server
// Per-connection message limiting as a token bucket rather than a fixed
// per-second window. `doInitialSync` sends one push_entity PER ENTITY, so a
// large burst is normal and only a sustained rate indicates a loop; a fixed
// window cannot tell the two apart, and closes any client whose local data
// exceeds one window mid-push, leaving it to retry and loop forever. `BURST`
// covers a full initial push in one go, and `REFILL_PER_SEC` is the only rate
// sustainable indefinitely, so a client stuck in a push loop still trips.
const MSG_BURST = 5000; // matches MAX_PULL_ENTITIES, one full sync's worth
const MSG_REFILL_PER_SEC = 200;
const MAX_CONNECTIONS_PER_IP = 20; // trivial socket-exhaustion guard
const MAX_PULL_ENTITIES = 5000; // bounds the server's own per-pull work

type DbApi = ReturnType<typeof createDbApi>;

const PORT = config.port ?? 10_000;
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../certs");
const CONSOLE_DIST = join(dirname(fileURLToPath(import.meta.url)), "../console/dist");

// certs/tailscale.crt is a static snapshot with a 90-day lifetime and nothing
// renews it, so it goes stale silently. Tailscale Funnel on 443 serves the
// tailscaled cert, which auto-renews, so Funnel keeps working and only the
// direct port breaks. Warn before that happens rather than leaving a failed
// client connection as the first symptom.
const CERT_WARN_DAYS = 7;
const CERT_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function warnIfCertExpiring(certPath: string): void {
  let validTo: Date;
  try {
    validTo = new Date(new X509Certificate(readFileSync(certPath)).validTo);
  } catch (err) {
    console.warn(`[cert] ${ts()} cannot read ${certPath}: ${(err as Error).message}`);
    return;
  }
  const msLeft = validTo.getTime() - Date.now();
  if (msLeft > CERT_WARN_DAYS * 86_400_000) return;
  const days = Math.floor(Math.abs(msLeft) / 86_400_000);
  const state = msLeft < 0 ? `expired ${days}d ago` : `expires in ${days}d`;
  console.warn(`[cert] ${ts()} ${certPath} ${state} (${validTo.toISOString()}).`);
  console.warn(`[cert] ${ts()}   Fix: pnpm certs:refresh, then restart this server.`);
}

/** What the sync server hands its HTTP request handler besides the request. */
export interface RequestContext {
  monitor: Monitor;
}

async function handleImport(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
  if (config.tiers.length === 0) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "No import model configured on server" }));
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
  const chain = config.tiers.map((t) => `[${t.map((m) => m.model).join(", ")}]`).join(" -> ");
  console.log(`[import] ${new Date().toISOString()} scope=${scope.type} tiers=${chain} image=${imageKB}KB`);
  const t0 = Date.now();
  let result: Awaited<ReturnType<typeof extractFromImage>>;
  try {
    result = await extractFromImage(image, mime_type, scope, config.tiers);
  } catch (err) {
    ctx.monitor.importFinished(t0, err instanceof Error ? err.message : String(err));
    throw err;
  }
  ctx.monitor.importFinished(t0, null);
  console.log(`[import] done in ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.boards?.length ?? 0} boards`);
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
  // Comma-separated extras, such as the e2e harness's app origin.
  ...(process.env.LISTR_EXTRA_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
]);

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.has(origin) ? origin : "");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

const handler = (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => {
    setCorsHeaders(req, res);
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET" && req.url === "/api/models") {
      const apiKey = config.tiers.flat()[0]?.fields.api_key;
      if (!apiKey) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "No API key" })); return; }
      (async () => {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await r.json();
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      })().catch((err) => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: String(err) })); });
      return;
    }
    if (req.method === "POST" && req.url === "/api/import") {
      handleImport(req, res, ctx).catch((err) => {
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
  /** Integration modules to offer. Defaults to the built-in set. Tests override it. */
  integrationModules?: Map<string, IntegrationModule>;
  integrationRunner?: RunnerOptions;
  requestHandler?: (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => void;
  /** Operator console settings. Defaults to the process config's `console`. */
  console?: ConsoleConfig;
  /** Where the built console frontend lives. Tests override it. */
  consoleDistDir?: string;
  /** Which world this server belongs to (dev/prod/...), advertised in
   * `challenge` so clients can refuse to talk to the wrong one. Defaults to the
   * process config's variant; tests override it directly. */
  variant?: string;
  /** Let the first client to authenticate against a database with no users at
   * all claim it as root. Defaults to the process config's `allow_bootstrap`
   * (see config.ts); tests override it directly. */
  allowBootstrap?: boolean;
}

export interface SyncServerHandle {
  httpServer: ReturnType<typeof createHttpServer>;
  wss: WebSocketServer;
  monitor: Monitor;
  integrationRunner: IntegrationRunner;
  stop(): void;
}

// Build one independent sync server instance around a given DbApi. This lives
// outside module scope so tests can start a server against an in-memory db and
// an ephemeral port rather than the production singleton.
export function createSyncServer(dbApi: DbApi, opts: SyncServerOptions = {}): SyncServerHandle {
  const SERVER_ID = dbApi.getServerId();
  const SERVER_VARIANT = opts.variant ?? config.variant;
  const ALLOW_BOOTSTRAP = opts.allowBootstrap ?? config.allow_bootstrap ?? false;

  // A database with no users rejects every client with `needs_grant`, and
  // nothing in the protocol can dig it out, since issuing the grant that
  // registration needs requires a user to issue it. Say so here rather than
  // leaving it to be diagnosed from a client-side "Not registered".
  if (dbApi.countUsers() === 0) {
    if (ALLOW_BOOTSTRAP) {
      console.warn(`[startup] ${ts()} no users in this database and bootstrap is enabled: the next client to authenticate becomes root.`);
    } else {
      console.warn(`[startup] ${ts()} no users in this database; every client will sit in "Not registered" until one is registered.`);
      console.warn(`[startup] ${ts()}   Fix: pnpm --filter @listr/server auth bootstrap-root --apply, then auth issue-grant --issuer=<root> --kind=device --apply`);
      console.warn(`[startup] ${ts()}   Or restart with LISTR_ALLOW_BOOTSTRAP=1 to let the first client to connect claim this server.`);
    }
  }
  const requestHandler = opts.requestHandler ?? ((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Listr sync server running\n");
  });

  const consoleConfig = opts.console ?? config.console ?? {};
  const monitor = new Monitor({ captureBodies: consoleConfig.capture_bodies ?? true });
  const stopAuthEvents = dbApi.onAuthEvent(() => monitor.markDirty("trust"));
  let consoleRouter: ConsoleRouter | null = null;

  // The console gets first look at every request, and /console answers 404
  // when no password is configured.
  const dispatch = (req: IncomingMessage, res: ServerResponse) => {
    if (consoleRouter?.handle(req, res)) return;
    if (req.url === "/console" || req.url?.startsWith("/console/")) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found\n");
      return;
    }
    requestHandler(req, res, { monitor });
  };

  const certPath = join(opts.certDir ?? CERT_DIR, "tailscale.crt");
  const httpServer = opts.tls === false
    ? createHttpServer(dispatch)
    : createHttpsServer(
        {
          key: readFileSync(join(opts.certDir ?? CERT_DIR, "tailscale.key")),
          cert: readFileSync(certPath),
        },
        dispatch,
      );

  // Check on a slow timer as well as at startup, since this process can outlive
  // the cert and a boot-only warning would scroll away long before it matters.
  let certTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.tls !== false) {
    warnIfCertExpiring(certPath);
    certTimer = setInterval(() => warnIfCertExpiring(certPath), CERT_CHECK_INTERVAL_MS);
    certTimer.unref(); // a warning must never hold the process open
  }

  // The app and the sync server are permanently different origins
  // (listr.aapx.org vs listr-sync.aapx.org), so Origin is a meaningful signal
  // here, unlike in a same-origin app. A request with no Origin header is
  // allowed through rather than rejected: browsers always send Origin on a
  // cross-origin WS handshake, so an absent header means a non-browser client,
  // such as the `ws` client this repo's test harness uses or a CLI or native
  // client. This check exists to stop an unexpected *browser* origin, not to
  // require one.
  //
  // connectionsPerIp counts connections currently open per remote IP, checked
  // at upgrade time, before the handshake does any crypto. An unauthenticated
  // handshake still costs a signature verification, making it an amplification
  // target worth gating before the socket is accepted at all. Increment in
  // verifyClient rather than in the "connection" handler, so a burst of
  // concurrent upgrades from one IP cannot all pass the check before any of
  // them is counted.
  const connectionsPerIp = new Map<string, number>();
  const ipOf = (req: IncomingMessage): string => req.socket.remoteAddress ?? "unknown";

  const wss = new WebSocketServer({
    server: httpServer,
    maxPayload: MAX_WS_PAYLOAD_BYTES,
    verifyClient: (info, callback) => {
      const origin = info.origin;
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        monitor.upgradeRejected("origin");
        console.warn(`[ws] ${ts()} rejected upgrade from disallowed origin: ${origin}`);
        callback(false, 403, "Origin not allowed");
        return;
      }
      const ip = ipOf(info.req);
      const count = connectionsPerIp.get(ip) ?? 0;
      if (count >= MAX_CONNECTIONS_PER_IP) {
        monitor.upgradeRejected("per_ip");
        console.warn(`[ws] ${ts()} rejected upgrade from ${ip}: ${count} connections already open (limit ${MAX_CONNECTIONS_PER_IP})`);
        callback(false, 429, "Too many connections");
        return;
      }
      connectionsPerIp.set(ip, count + 1);
      callback(true);
    },
  });

  // sync_key -> connected clients (a client may appear under multiple keys)
  const keyToClients = new Map<string, Set<WebSocket>>();

  // home_key ("user") -> every currently-open connection presenting that home
  // key, regardless of which other sync_keys it is subscribed to. Tells a
  // user's *other* already-open connections about a key they do not know about
  // yet, or one they should drop, without waiting for their next reconnect.
  // See notifyUserKeyChange/notifyUserKeyRemoved below.
  const homeKeyToClients = new Map<string, Set<WebSocket>>();

  function broadcast(syncKey: string, sender: WebSocket | null, msg: unknown): void {
    const clientSet = keyToClients.get(syncKey);
    if (!clientSet) return;
    const json = JSON.stringify(msg);
    for (const ws of clientSet) {
      if (ws !== sender && ws.readyState === WebSocket.OPEN) ws.send(json);
    }
  }

  // Tell a user's other open connections that a key belongs to them, either a
  // new association or a name set or changed on one they already had. The key
  // and name are all the client needs: receiving them is enough for it to mark
  // that key locally, which cascades through its own recompute-and-reconnect
  // into pulling the key's actual data normally.
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

  /**
   * Push the current device list to every open connection of one user.
   *
   * `list_clients` is request/response, so on its own a device added or
   * renamed on one machine leaves every other machine's list silently stale
   * until someone hits Refresh. This is the same fan-out `notifyUserKeyChange`
   * uses, and it deliberately includes the sender: after a `redeem_grant` the
   * joining device wants the list too, and after a rename the reply IS this
   * message.
   */
  function notifyClientsChanged(homeKey: string, userId: string): void {
    const conns = homeKeyToClients.get(homeKey);
    if (!conns || conns.size === 0) return;
    const clients = dbApi.getClientsForUser(userId).map((c) => ({
      client_id: c.client_id,
      label: c.label,
      created_at: c.created_at,
      last_seen: c.last_seen,
    }));
    const json = JSON.stringify({ type: "clients", clients });
    for (const client of conns) {
      if (client.readyState === WebSocket.OPEN) client.send(json);
    }
  }

  const integrationRunner = new IntegrationRunner(
    dbApi, opts.integrationModules ?? INTEGRATIONS, opts.integrations ?? {}, broadcast,
    { ...opts.integrationRunner, observer: monitor.runObserver },
  );
  integrationRunner.start();

  if (consoleConfig.password_hash) {
    consoleRouter = new ConsoleRouter({
      db: dbApi,
      monitor,
      runner: integrationRunner,
      httpServer,
      passwordHash: consoleConfig.password_hash,
      sessionIdleHours: consoleConfig.session_idle_hours,
      tls: opts.tls !== false,
      variant: SERVER_VARIANT,
      certPath: opts.tls === false ? null : certPath,
      allowedOrigins: [...ALLOWED_ORIGINS],
      importTiers: config.tiers,
      externalUrls: consoleConfig.external_urls ?? [],
      distDir: opts.consoleDistDir ?? CONSOLE_DIST,
      tokenBurst: MSG_BURST,
    });
    // Browsers drop Secure cookies over plain HTTP except on localhost, so
    // the session cookie goes without Secure when TLS is off. Say so if that
    // is anywhere but loopback.
    if (opts.tls === false) {
      httpServer.on("listening", () => {
        const addr = httpServer.address();
        const host = typeof addr === "object" && addr ? addr.address : "";
        if (host !== "127.0.0.1" && host !== "::1") {
          console.warn(`[console] ${ts()} TLS is off and this server listens on ${host}: the console password and session cookie cross the network in the clear.`);
        }
      });
    }
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const connIp = ipOf(req);
    const conn = monitor.connOpened(req);
    // Every reply and broadcast to this socket goes through send, so wrapping
    // it here is enough for the console to see all outgoing traffic.
    const rawSend = ws.send.bind(ws) as (data: unknown, ...rest: unknown[]) => void;
    (ws as unknown as { send: (data: unknown, ...rest: unknown[]) => void }).send = (data: unknown, ...rest: unknown[]) => {
      monitor.messageOut(conn, data);
      rawSend(data, ...rest);
    };
    // Per-connection message-rate limiting, as a token bucket refilled on
    // every message. Checked before JSON.parse so the cost is bounded
    // regardless of what the client sends.
    let msgTokens = MSG_BURST;
    let msgTokensRefilledAt = Date.now();
    let syncKeys: string[] = [];
    let homeKey: string | null = null; // this connection's authenticated home key, once ok/needs_grant is resolved
    let userId: string | null = null; // set once this connection is authenticated (post-ok, or post-redeem_grant)
    let clientId: string | null = null; // full RFC 7638 thumbprint, set at hello time (pre-authentication)
    let clientVersion = 0;
    let pubkeyJwk: Record<string, unknown> | null = null; // set at hello time, needed again by redeem_grant
    let declaredKeys: string[] = []; // this connection's hello.keys, held until auth succeeds
    // Single in-flight nonce per connection: 128 bits, single-use, consumed by
    // the very next `auth` attempt regardless of outcome, with a 60s TTL. A
    // per-connection nonce is sufficient for replay resistance across
    // connections, because a captured (nonce, sig) pair was signed against
    // *this* connection's nonce and any other connection, including a
    // reconnect, gets its own fresh one, so the signature will not verify
    // there. See authCrypto.ts's verifyAuthSignature and its
    // cross-server-replay test.
    let expectedNonce: string | null = null;
    let nonceExpiresAt = 0;
    let authenticated = false;
    let connectedAt = 0;
    const pushCounts: Partial<Record<string, number>> = {};

    // Finish authenticating this connection as `user`. Shared by the normal
    // auth success path and by a successful redeem_grant, which is the same
    // "we now know who this connection is" event from a different cause: a
    // brand-new client redeeming a grant should reach a working `ok` without a
    // second round trip.
    function completeAuthentication(user: UserRow): void {
      // Auto-associate every key this client declared (other than its own home
      // key) with its user, so this user's other devices learn about it too.
      const knownBefore = new Set(dbApi.getUserKeys(user.user_id).map((u) => u.key));
      const newlyAssociated: string[] = [];
      for (const k of declaredKeys) {
        if (k === user.home_key) continue;
        dbApi.associateUserKey(user.user_id, k, null, "declared");
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
      monitor.connAuthenticated(conn, user.user_id, syncKeys);
      console.log(`[ws] ${ts()} ${keyTag(syncKeys)} connect client=${clientId!.slice(0, 8)} user=${user.user_id.slice(0, 8)} protocol=${clientVersion} keys=${syncKeys.length}`);
      ws.send(JSON.stringify({
        type: "ok",
        user_id: user.user_id,
        home_key: user.home_key,
        display_name: user.display_name,
        caps: user.caps,
        user_keys: userKeys,
        integrations: integrationRunner.describe(),
        server_time: Date.now(),
      }));
    }

    ws.on("message", (raw: Buffer) => {
      // Rate limit, checked before parsing anything. This is the
      // highest-value of the four limits, because it catches both a curious
      // script and an honest client bug looping on push, which looks exactly
      // like an attack and is the more likely case.
      const nowMs = Date.now();
      msgTokens = Math.min(MSG_BURST, msgTokens + ((nowMs - msgTokensRefilledAt) / 1000) * MSG_REFILL_PER_SEC);
      msgTokensRefilledAt = nowMs;
      if (msgTokens < 1) {
        console.warn(
          `[ws] ${ts()} closing ip=${connIp} client=${clientId?.slice(0, 8) ?? "?"}: sustained rate above ${MSG_REFILL_PER_SEC} msg/sec (burst ${MSG_BURST} exhausted)`,
        );
        monitor.rateLimited(conn);
        ws.close(1008, "Rate limit exceeded");
        return;
      }
      msgTokens--;
      monitor.tokenLevel(conn, msgTokens);

      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        monitor.messageIn(conn, raw.length, { type: "(invalid json)" });
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }
      monitor.messageIn(conn, raw.length, msg ?? {});

      // -- hello: version-gate, then issue a challenge -----------------------
      if (msg.type === "hello") {
        clientVersion = typeof msg.protocol_version === "number" ? msg.protocol_version : 0;
        monitor.connProtocol(conn, clientVersion);
        if (clientVersion < MIN_PROTOCOL_VERSION || clientVersion > MAX_PROTOCOL_VERSION) {
          const range = MIN_PROTOCOL_VERSION === MAX_PROTOCOL_VERSION
            ? `${MIN_PROTOCOL_VERSION}`
            : `${MIN_PROTOCOL_VERSION}-${MAX_PROTOCOL_VERSION}`;
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

        // Self-consistency check, before anything else: client_id must be the
        // thumbprint of the key it claims. That makes signature verification
        // at `auth` time self-contained, so the `clients` table row, if any,
        // is consulted only for registration status and never trusted to
        // supply the identity itself.
        jwkThumbprint(pubkey)
          .then((computed) => {
            if (computed !== helloClientId) {
              console.log(`[ws] ${ts()} reject client_id ${helloClientId.slice(0, 8)}... does not match pubkey_jwk thumbprint`);
              ws.send(JSON.stringify({ type: "error", message: "client_id does not match pubkey_jwk", reason: "protocol" }));
              ws.close(1008, "client_id mismatch");
              return;
            }

            clientId = helloClientId;
            pubkeyJwk = pubkey;
            declaredKeys = keys;
            monitor.connChallenged(conn, helloClientId, clientVersion);

            const nonce = randomBytes(16).toString("base64url"); // 128 bits
            expectedNonce = nonce;
            nonceExpiresAt = Date.now() + NONCE_TTL_MS;

            ws.send(JSON.stringify({
              type: "challenge",
              nonce,
              server_id: SERVER_ID,
              // Variant travels in `challenge` rather than `ok`, so a dev/prod
              // mismatch is caught before the client does any crypto at all.
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

      // -- auth: verify the signed nonce, then ok / needs_grant / error ------
      if (msg.type === "auth") {
        if (!clientId || !pubkeyJwk || !expectedNonce) {
          ws.send(JSON.stringify({ type: "error", message: "No pending challenge", reason: "protocol" }));
          return;
        }
        const nonce = expectedNonce;
        const expired = Date.now() > nonceExpiresAt;
        expectedNonce = null; // single-use: consumed by this attempt regardless of outcome

        if (expired) {
          monitor.authFailed(conn, "challenge_expired");
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
              monitor.authFailed(conn, "bad_signature");
              console.log(`[ws] ${ts()} auth failed client=${capturedClientId.slice(0, 8)}... bad signature`);
              ws.send(JSON.stringify({ type: "error", message: "Invalid signature", reason: "bad_signature" }));
              ws.close(1008, "Invalid signature");
              return;
            }

            const record = dbApi.getUserForClient(capturedClientId);
            if (!record) {
              // Nobody here yet? Then this client can become the root user,
              // if the operator asked for that. claimEmptyServer re-checks
              // emptiness inside its transaction, so two clients racing on a
              // fresh server cannot both claim it.
              const claimed = ALLOW_BOOTSTRAP
                ? dbApi.claimEmptyServer(
                    { clientId: capturedClientId, pubkeyJwk: JSON.stringify(capturedPubkey) },
                    Date.now(),
                  )
                : null;
              if (claimed) {
                console.warn(`[ws] ${ts()} bootstrap: client=${capturedClientId.slice(0, 8)} claimed this empty server as root user=${claimed.user.user_id.slice(0, 8)}`);
                completeAuthentication(claimed.user);
                return;
              }
              monitor.connNeedsGrant(conn);
              ws.send(JSON.stringify({ type: "needs_grant" }));
              return;
            }
            if (record.effectiveState !== "active") {
              monitor.authFailed(conn, record.effectiveState);
              console.log(`[ws] ${ts()} client=${capturedClientId.slice(0, 8)}... rejected: ${record.effectiveState}`);
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

      // -- redeem_grant: registration plumbing, no UI here -------------------
      // Works whether this connection is still unauthenticated, as for
      // invite/device/guest, which register a brand-new client, or already
      // authenticated, as for share, which hands one more key to the existing
      // user. db.ts's applyGrantEffect picks whichever of clientId/pubkeyJwk
      // or existingUserId a given grant kind needs.
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
        // A `device` grant just added a machine to this user's account, so the
        // user's OTHER open connections hold a stale device list. Call this
        // after completeAuthentication, so this connection is already in the
        // fan-out set and gets the list too. For invite/guest the redeemer is
        // a brand-new user, so this reaches only their own single connection,
        // which is right by construction: the issuer's own device list is
        // unchanged.
        notifyClientsChanged(result.result.user.home_key, result.result.user.user_id);
        return;
      }

      // -- peek_grant: read-only preview -------------------------------------
      // The join screen shows the grant's greeting and the voucher's display
      // name BEFORE the account is created, and redemption is single-use, so
      // it cannot double as a preview. Works unauthenticated, like
      // redeem_grant, since a brand-new client parked in needs_grant is
      // exactly who needs this.
      if (msg.type === "peek_grant") {
        const grantId = typeof msg.grant_id === "string" ? msg.grant_id : "";
        const secret = typeof msg.secret === "string" ? msg.secret : "";
        if (!grantId || !secret) {
          ws.send(JSON.stringify({ type: "error", message: "peek_grant requires grant_id and secret" }));
          return;
        }
        const peek = dbApi.peekGrant(grantId, secret, Date.now());
        if (!peek.ok) {
          ws.send(JSON.stringify({ type: "error", message: `Grant lookup failed: ${peek.reason}`, reason: peek.reason }));
          return;
        }
        ws.send(JSON.stringify({
          type: "grant_info",
          kind: peek.grant.kind,
          greeting: peek.grant.greeting,
          issuer_display_name: peek.issuerDisplayName,
          expires_at: peek.grant.expires_at,
        }));
        return;
      }

      if (!authenticated) {
        ws.send(JSON.stringify({ type: "error", message: "Not authenticated", reason: "protocol" }));
        return;
      }

      if (msg.type === "pull") {
        // v3: { keys: [{ key, since }] }. v2 compat: { since } applied to all keys.
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
        // same asset can legitimately match more than one requested key. Dedupe
        // by id rather than concatenating as the other entity types do.
        const assetsById = new Map<string, unknown>();
        const serverTimes: Record<string, number> = {};
        const now = Date.now();

        // Bound the server's own per-pull work. Skip WHOLESALE any key whose
        // result would push the total over budget, rather than truncating it:
        // its entities stay out of the response and its entry stays out of
        // `server_times`, so the client's existing since-cursor for that key
        // (in key_sync_state) is untouched and it picks the whole key back up
        // on its next pull, at the next reconnect or a forced resync.
        // Truncating and still stamping server_times[key] = now would
        // permanently lose whatever did not fit.
        let pulledTotal = 0;
        for (const { key, since } of keysSince) {
          const boards = dbApi.getEntitiesSince("board", key, since);
          const lists = dbApi.getEntitiesSince("list", key, since);
          const items = dbApi.getEntitiesSince("item", key, since);
          const assets = dbApi.getEntitiesSince("asset", key, since) as { id: string }[];
          const tombstones = dbApi.getTombstonesSince(key, since);
          const integrationResults = dbApi.getIntegrationResultsSince(key, since);
          const count = boards.length + lists.length + items.length + assets.length + tombstones.length + integrationResults.length;

          if (pulledTotal + count > MAX_PULL_ENTITIES) {
            console.warn(`[sync] ${ts()} pull budget exceeded for key ${key.slice(0, 6)} (${count} entities, ${pulledTotal} already queued), deferred to next pull`);
            continue;
          }
          pulledTotal += count;

          allBoards.push(...boards);
          allLists.push(...lists);
          allItems.push(...items);
          for (const a of assets) assetsById.set(a.id, a);
          allTombstones.push(...tombstones);
          allIntegrationResults.push(...integrationResults);
          serverTimes[key] = now;
        }

        const allAssets = [...assetsById.values()];
        monitor.pull(conn, keysSince, {
          boards: allBoards.length, lists: allLists.length, items: allItems.length, assets: allAssets.length,
          tombstones: allTombstones.length, integration_results: allIntegrationResults.length,
        });

        const pushed = Object.entries(pushCounts).map(([k, v]) => `${k}=${v}`).join(" ");
        for (const k of Object.keys(pushCounts)) delete pushCounts[k];
        console.log(`[sync] ${ts()} ${keyTag(syncKeys)} client=${clientId?.slice(0, 8)} pull keys=${keysSince.length}${pushed ? ` pushed: ${pushed}` : ""} -> boards=${allBoards.length} lists=${allLists.length} items=${allItems.length} assets=${allAssets.length} tombstones=${allTombstones.length} integration_results=${allIntegrationResults.length}`);

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
        const entityType = msg.entity_type as EntityType;
        const data = msg.data as Record<string, unknown>;
        const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : "";
        if (!data?.id || !syncKey) return;
        // Integration results belong to the server's runner. Clients change them only by editing items.
        if (!SYNCED_ENTITY_TYPES.has(entityType)) return;
        const { accepted, previous, rekeyed } = dbApi.upsertEntity(entityType, data, syncKey);
        if (accepted) {
          broadcast(syncKey, ws, { type: "entity", entity_type: entityType, data });
          if (entityType === "item") integrationRunner.onItemChanged(data.id as string);
          if (entityType === "board") integrationRunner.onBoardChanged(data as unknown as Board, previous as Board | null);
        } else if (rekeyed) {
          // Content was stale, but the entity just moved into this
          // namespace. Anyone already listening on the new key needs it, and
          // needs the stored version rather than the stale push.
          broadcast(syncKey, ws, { type: "entity", entity_type: entityType, data: rekeyed });
        }
        pushCounts[entityType] = (pushCounts[entityType] ?? 0) + 1;
        return;
      }

      if (msg.type === "push_delete") {
        const entityType = msg.entity_type as EntityType;
        const entityId = msg.entity_id as string;
        const deletedAt = msg.deleted_at as number;
        const syncKey = typeof msg.sync_key === "string" ? msg.sync_key : "";
        if (!entityId || !deletedAt || !syncKey || !SYNCED_ENTITY_TYPES.has(entityType)) return;
        if (dbApi.applyTombstone(entityType, entityId, deletedAt, syncKey)) {
          if (entityType === "item") integrationRunner.onItemDeleted(entityId);
          broadcast(syncKey, ws, { type: "deleted", entity_type: entityType, entity_id: entityId, deleted_at: deletedAt });
          console.log(`[sync] ${ts()} ${keyTag([syncKey])} delete ${entityType} id=${entityId}`);
        }
        return;
      }

      if (msg.type === "associate_key") {
        // The identity acted on is always this connection's own authenticated
        // identity, the userId and homeKey resolved by the handshake. This
        // message carries no client-supplied identity field, so there is
        // nothing for a client to spoof another user's home key with.
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        const name = typeof msg.name === "string" && msg.name ? msg.name : null;
        if (homeKey && userId && key && key !== homeKey) {
          dbApi.associateUserKey(userId, key, name, "associated");
          if (!keyToClients.has(key)) keyToClients.set(key, new Set());
          keyToClients.get(key)!.add(ws);
          if (!syncKeys.includes(key)) syncKeys.push(key);
          monitor.connKeys(conn, syncKeys);
          // Resolve the actual stored name (associateUserKey never clobbers an
          // existing name with null) so siblings learn the real current value.
          const current = dbApi.getUserKeys(userId).find((u) => u.key === key);
          notifyUserKeyChange(homeKey, key, current?.name ?? null, ws);
        }
        return;
      }

      if (msg.type === "leave_key") {
        // Same rule as associate_key above: identity comes from the
        // connection, and there is no message-body field to spoof it with.
        const key = typeof msg.key === "string" ? msg.key.trim() : "";
        if (homeKey && userId && key) {
          dbApi.removeUserKey(userId, key);
          keyToClients.get(key)?.delete(ws);
          syncKeys = syncKeys.filter((k) => k !== key);
          monitor.connKeys(conn, syncKeys);
          notifyUserKeyRemoved(homeKey, key, ws);
        }
        return;
      }

      // -- create_grant: grant-creation UI plumbing --------------------------
      // The issuer is always this connection's own authenticated identity, and
      // there is no issuer_user_id field on the wire to spoof, the same
      // pattern as associate_key and leave_key. Cap and attenuation
      // enforcement lives in dbApi.createGrant rather than here, so a client
      // that skips the UI's own `invite`-cap gate cannot bypass it.
      if (msg.type === "create_grant") {
        const kind = typeof msg.kind === "string" ? (msg.kind as GrantKind) : null;
        if (!kind || !["invite", "device", "share", "guest"].includes(kind)) {
          ws.send(JSON.stringify({ type: "error", message: "create_grant requires a valid kind" }));
          return;
        }
        const caps: Cap[] | undefined = Array.isArray(msg.caps)
          ? (msg.caps.filter((c: unknown) => typeof c === "string") as Cap[])
          : undefined;
        const payload = typeof msg.payload === "string" && msg.payload ? msg.payload : undefined;
        const payloadName = typeof msg.payload_name === "string" && msg.payload_name ? msg.payload_name : undefined;
        const greeting = typeof msg.greeting === "string" && msg.greeting ? msg.greeting : null;
        const expiresAt = typeof msg.expires_at === "number" ? msg.expires_at : undefined;
        const usesRemaining = typeof msg.uses_remaining === "number" ? msg.uses_remaining : undefined;

        try {
          const { grantId, secret } = dbApi.createGrant(
            { kind, issuerUserId: userId!, caps, payload, payloadName, greeting, expiresAt, usesRemaining },
            Date.now(),
          );
          const grant = dbApi.getGrant(grantId)!;
          ws.send(JSON.stringify({
            type: "grant_created",
            grant_id: grantId,
            secret,
            kind,
            greeting: grant.greeting,
            expires_at: grant.expires_at,
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err), reason: "cap_denied" }));
        }
        return;
      }

      // -- set_display_name: self-chosen nickname, never validated -----------
      if (msg.type === "set_display_name") {
        const displayName = typeof msg.display_name === "string" && msg.display_name.trim() ? msg.display_name.trim() : null;
        const updated = dbApi.setUserDisplayName(userId!, displayName, Date.now());
        ws.send(JSON.stringify({ type: "display_name_set", display_name: updated.display_name }));
        return;
      }

      // -- set_client_label: name one of your own devices --------------------
      // redeem_grant can also carry a label, but no UI passes one there, so
      // this is how a device gets a name instead of showing as "(unnamed
      // device)". Ownership is enforced inside setClientLabel's WHERE.
      if (msg.type === "set_client_label") {
        const targetClientId = typeof msg.client_id === "string" ? msg.client_id.trim() : "";
        const label = typeof msg.label === "string" && msg.label.trim() ? msg.label.trim() : null;
        if (!targetClientId) {
          ws.send(JSON.stringify({ type: "error", message: "set_client_label requires client_id", reason: "bad_request" }));
          return;
        }
        if (!dbApi.setClientLabel(targetClientId, userId!, label)) {
          ws.send(JSON.stringify({ type: "error", message: "No such device on this account", reason: "bad_request" }));
          return;
        }
        // Fan out rather than reply: every one of this user's devices shows
        // the same list, so a rename on one leaves the others stale. This
        // includes the sender, so it doubles as the reply.
        notifyClientsChanged(homeKey!, userId!);
        return;
      }

      // -- list_clients: "your devices" --------------------------------------
      if (msg.type === "list_clients") {
        const clients = dbApi.getClientsForUser(userId!).map((c) => ({
          client_id: c.client_id,
          label: c.label,
          created_at: c.created_at,
          last_seen: c.last_seen,
        }));
        ws.send(JSON.stringify({ type: "clients", clients }));
        return;
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      monitor.connClosed(conn, code, reason.toString());
      const remaining = (connectionsPerIp.get(connIp) ?? 1) - 1;
      if (remaining <= 0) connectionsPerIp.delete(connIp); else connectionsPerIp.set(connIp, remaining);
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
    monitor,
    integrationRunner,
    stop() {
      if (certTimer) clearInterval(certTimer);
      integrationRunner.stop();
      stopAuthEvents();
      monitor.stop();
      wss.close();
      httpServer.close();
    },
  };
}

// Production instance, run only when this module is the entry point. That
// guards against side effects such as HTTPS cert reads and PORT binding when
// index.ts is imported for its exports, as tests do.
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
