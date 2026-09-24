/**
 * HTTP side of the operator console: /console/api/* JSON, the SSE stream, and
 * the built frontend's static files. Mounted on the sync server's own
 * listener. Nothing here sets CORS headers, so only same-origin pages can call
 * it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { connect as tlsConnect, type PeerCertificate } from "node:tls";
import { X509Certificate } from "node:crypto";
import type {
  ConsoleCert, ConsoleClientDetail, ConsoleClientRow, ConsoleClients, ConsoleDevice, ConsoleExternalProbe,
  ConsoleGrant, ConsoleIntegrations, ConsoleKey, ConsoleOverview, ConsolePorts, ConsoleTrust, ConsoleUser,
  ConsoleUserDetail, ConsoleUserState,
} from "@listr/shared";
import type { createDbApi, GrantRow, UserRow } from "../db.js";
import type { IntegrationRunner } from "../integration-runner.js";
import type { ModelConfig } from "../config.js";
import { ConsoleAuth, parseCookies, SESSION_COOKIE } from "./auth.js";
import { connToWire, keyTag, type ConnRecord, type Monitor } from "./monitor.js";

type DbApi = ReturnType<typeof createDbApi>;

const PREFIX = "/console";
const API = `${PREFIX}/api`;
const MAX_BODY_BYTES = 10 * 1024;
const PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5000;
const MAX_GRANT_ATTEMPTS = 10;
const DAY_MS = 86_400_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
};

/** The HTTP routes this listener serves, for the Ports view. */
const ROUTES = ["/", "/api/models", "/api/import", "/console/*", "WebSocket upgrade"];

export interface ConsoleRouterOptions {
  db: DbApi;
  monitor: Monitor;
  runner: IntegrationRunner;
  httpServer: Server;
  passwordHash: string;
  sessionIdleHours?: number;
  tls: boolean;
  variant: string;
  certPath: string | null;
  allowedOrigins: string[];
  importTiers: ModelConfig[][];
  externalUrls: string[];
  distDir: string;
  /** The per-connection message bucket's size, for the token sparkline. */
  tokenBurst: number;
  now?: () => number;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

export function certInfo(pem: Buffer | string, now: number): ConsoleCert {
  const cert = new X509Certificate(pem);
  const validTo = new Date(cert.validTo).getTime();
  return {
    subject: cert.subject.replace(/\n/g, ", "),
    issuer: cert.issuer.replace(/\n/g, ", "),
    sans: (cert.subjectAltName ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    valid_to: validTo,
    days_left: Math.floor((validTo - now) / DAY_MS),
  };
}

function peerCertInfo(c: PeerCertificate, now: number): ConsoleCert {
  const validTo = new Date(c.valid_to).getTime();
  const name = (o: Record<string, unknown> | undefined) =>
    o ? Object.entries(o).map(([k, v]) => `${k}=${String(v)}`).join(", ") : "";
  return {
    subject: name(c.subject as unknown as Record<string, unknown>),
    issuer: name(c.issuer as unknown as Record<string, unknown>),
    sans: (c.subjectaltname ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    valid_to: validTo,
    days_left: Math.floor((validTo - now) / DAY_MS),
  };
}

function grantStatus(g: GrantRow, now: number): ConsoleGrant["status"] {
  if (g.attempts >= MAX_GRANT_ATTEMPTS && g.uses_remaining <= 0) return "burned";
  if (g.uses_remaining <= 0) return "used";
  if (g.expires_at <= now) return "expired";
  return "outstanding";
}

function lastUtcMidnight(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

export class ConsoleRouter {
  readonly auth: ConsoleAuth;
  private probes: ConsoleExternalProbe[] = [];
  private probedAt = 0;
  private probing: Promise<void> | null = null;
  private now: () => number;

  constructor(private o: ConsoleRouterOptions) {
    this.auth = new ConsoleAuth(o.passwordHash, { idleHours: o.sessionIdleHours, now: o.now });
    this.now = o.now ?? Date.now;
    o.monitor.setStatsProvider("integration.stats", () => this.integrations());
    o.monitor.setStatsProvider("client.stats", () => this.clients());
    o.monitor.setStatsProvider("ports.stats", () => this.portsSync());
    o.monitor.setStatsProvider("trust", () => null);
  }

  /** Handle the request if it is under /console. Returns false otherwise. */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
    this.route(req, res, url).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(`[console] ${req.method} ${path}:`, err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    });
    return true;
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname;
    if (path === PREFIX) {
      res.writeHead(301, { Location: `${PREFIX}/` });
      res.end();
      return;
    }
    if (!path.startsWith(`${API}/`)) {
      this.serveStatic(path, res);
      return;
    }
    const route = path.slice(API.length);
    const method = req.method ?? "GET";

    if (method !== "GET") this.checkCsrf(req);

    if (method === "POST" && route === "/login") return this.login(req, res);
    if (method === "POST" && route === "/logout") {
      const sid = parseCookies(req)[SESSION_COOKIE];
      if (sid) this.auth.logout(sid);
      sendJson(res, 200, { ok: true }, { "Set-Cookie": this.cookie("", 0) });
      return;
    }
    const authed = this.auth.check(parseCookies(req)[SESSION_COOKIE]);
    if (method === "GET" && route === "/session") {
      sendJson(res, 200, { authenticated: authed });
      return;
    }
    if (!authed) throw new HttpError(401, "Not logged in");
    if (method !== "GET") throw new HttpError(405, "Method not allowed");

    const q = url.searchParams;
    const num = (name: string) => (q.has(name) ? Number(q.get(name)) : undefined);
    const str = (name: string) => q.get(name) || undefined;
    let m: RegExpMatchArray | null;

    if (route === "/stream") return this.o.monitor.subscribe(req, res);
    if (route === "/overview") return sendJson(res, 200, this.overview());
    if (route === "/trust") return sendJson(res, 200, this.trust());
    if ((m = route.match(/^\/trust\/users\/([^/]+)$/))) {
      const detail = this.userDetail(decodeURIComponent(m[1]));
      if (!detail) throw new HttpError(404, "No such user");
      return sendJson(res, 200, detail);
    }
    if (route === "/events") {
      return sendJson(res, 200, this.o.db.queryAuthEvents({
        kind: str("kind"), userId: str("user"), beforeId: num("before"), limit: Math.min(num("limit") ?? 100, 500),
      }));
    }
    if (route === "/integrations") return sendJson(res, 200, this.integrations());
    if (route === "/integrations/runs") {
      return sendJson(res, 200, this.o.monitor.listRuns({
        module: str("module"), outcome: str("outcome"), key: str("key"), item: str("item"),
        beforeId: num("before"), limit: Math.min(num("limit") ?? 100, 500),
      }));
    }
    if ((m = route.match(/^\/integrations\/runs\/(\d+)$/))) {
      const run = this.o.monitor.runDetail(Number(m[1]));
      if (!run) throw new HttpError(404, "Run no longer in the buffer");
      return sendJson(res, 200, run);
    }
    if (route === "/ports") return sendJson(res, 200, await this.ports());
    if (route === "/clients") return sendJson(res, 200, this.clients());
    if ((m = route.match(/^\/clients\/([^/]+)$/))) {
      const detail = this.clientDetail(decodeURIComponent(m[1]));
      if (!detail) throw new HttpError(404, "No such client");
      return sendJson(res, 200, detail);
    }
    throw new HttpError(404, "Not found");
  }

  // -- Auth -----------------------------------------------------------------------

  // SameSite=Strict does most of the work. A JSON content type and a
  // same-origin Origin header close the rest for non-GET requests.
  private checkCsrf(req: IncomingMessage): void {
    const type = req.headers["content-type"] ?? "";
    if (!type.startsWith("application/json")) throw new HttpError(415, "Expected application/json");
    const origin = req.headers.origin;
    const hosts = [req.headers.host, req.headers["x-forwarded-host"]].filter((h): h is string => typeof h === "string");
    let originHost: string | null = null;
    try {
      originHost = origin ? new URL(origin).host : null;
    } catch {
      originHost = null;
    }
    if (!originHost || !hosts.includes(originHost)) throw new HttpError(403, "Cross-origin request refused");
  }

  private cookie(value: string, maxAgeSec: number): string {
    return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${PREFIX}; Max-Age=${maxAgeSec}${this.o.tls ? "; Secure" : ""}`;
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let password = "";
    try {
      const body = JSON.parse(await readBody(req)) as { password?: unknown };
      password = typeof body.password === "string" ? body.password : "";
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "Bad request");
    }
    const result = this.auth.login(password);
    if (!result.ok) {
      if (result.retryAfterMs !== null) {
        const secs = Math.ceil(result.retryAfterMs / 1000);
        sendJson(res, 429, { error: `Too many failed logins. Try again in ${secs}s.` }, { "Retry-After": String(secs) });
        return;
      }
      console.warn(`[console] ${new Date(this.now()).toISOString()} failed login from ${req.socket.remoteAddress ?? "?"}`);
      sendJson(res, 401, { error: "Wrong password" });
      return;
    }
    console.log(`[console] ${new Date(this.now()).toISOString()} login from ${req.socket.remoteAddress ?? "?"}`);
    sendJson(res, 200, { ok: true }, { "Set-Cookie": this.cookie(result.sessionId, 7 * 24 * 3600) });
  }

  // -- Static files -----------------------------------------------------------------

  private serveStatic(path: string, res: ServerResponse): void {
    const root = resolve(this.o.distDir);
    const index = join(root, "index.html");
    if (!existsSync(index)) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS });
      res.end("The console is not built. Run: pnpm --filter @listr/server console:build\n");
      return;
    }
    const rel = normalize(decodeURIComponent(path.slice(PREFIX.length))).replace(/^([/\\])+/, "");
    let file = resolve(root, rel);
    if (file !== root && !file.startsWith(root + sep)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile) {
      // Unknown asset paths are real 404s. Anything else is a client route.
      if (extname(file)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      file = index;
    }
    const immutable = file.startsWith(join(root, "assets") + sep);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      ...SECURITY_HEADERS,
    });
    res.end(readFileSync(file));
  }

  // -- Snapshots ----------------------------------------------------------------------

  private cert(): { cert: ConsoleCert | null; error: string | null } {
    if (!this.o.certPath || !this.o.tls) return { cert: null, error: null };
    try {
      return { cert: certInfo(readFileSync(this.o.certPath), this.now()), error: null };
    } catch (err) {
      return { cert: null, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private connectedClientIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.o.monitor.open.values()) if (c.clientId && c.state === "authenticated") ids.add(c.clientId);
    return ids;
  }

  overview(): ConsoleOverview {
    const integrations = this.integrations();
    return {
      variant: this.o.variant,
      started_at: this.o.monitor.startedAt,
      users: this.o.db.countUsers(),
      clients_registered: this.o.db.listAllClients().length,
      clients_connected: this.connectedClientIds().size,
      integrations: integrations.modules.map((m) => ({
        id: m.id, name: m.name, healthy: m.active && m.errors_last_5m === 0 && m.quota_resets_at === null,
      })),
      cert_days_left: this.cert().cert?.days_left ?? null,
    };
  }

  private toUser(u: UserRow, deviceCount: number, keyCount: number): ConsoleUser {
    return {
      user_id: u.user_id, display_name: u.display_name, authorized_by: u.authorized_by, note: u.note,
      caps: u.caps, state: u.state, effective_state: (this.o.db.getEffectiveState(u.user_id) ?? u.state) as ConsoleUserState,
      provisional: u.provisional, created_at: u.created_at, home_key_tag: keyTag(u.home_key),
      device_count: deviceCount, key_count: keyCount,
    };
  }

  private toGrant(g: GrantRow, redemptions: Map<string, { at: number; user_id: string; client_id: string | null }[]>): ConsoleGrant {
    return {
      id: g.id, kind: g.kind, issuer_user_id: g.issuer_user_id, caps: g.caps,
      key_tag: g.payload ? keyTag(g.payload) : null, key_name: g.payload_name, greeting: g.greeting,
      expires_at: g.expires_at, uses_remaining: g.uses_remaining, attempts: g.attempts, created_at: g.created_at,
      status: grantStatus(g, this.now()), redemptions: redemptions.get(g.id) ?? [],
    };
  }

  private redemptionsByGrant() {
    const map = new Map<string, { at: number; user_id: string; client_id: string | null }[]>();
    for (const r of this.o.db.listGrantRedemptions()) {
      const list = map.get(r.grant_id) ?? [];
      list.push({ at: r.at, user_id: r.user_id, client_id: r.client_id });
      map.set(r.grant_id, list);
    }
    return map;
  }

  private devices(): ConsoleDevice[] {
    const connected = this.connectedClientIds();
    return this.o.db.listAllClients().map((c) => ({
      client_id: c.client_id, user_id: c.user_id, label: c.label, created_at: c.created_at,
      last_seen: c.last_seen, connected: connected.has(c.client_id),
    }));
  }

  trust(): ConsoleTrust {
    const db = this.o.db;
    const users = db.listAllUsers();
    const devices = this.devices();
    const userKeys = db.listAllUserKeys();
    const redemptions = this.redemptionsByGrant();

    const keys = new Map<string, ConsoleKey>();
    const keyFor = (key: string): ConsoleKey => {
      let k = keys.get(key);
      if (!k) {
        k = { tag: keyTag(key), name: null, boards: 0, lists: 0, items: 0, holders: [] };
        keys.set(key, k);
      }
      return k;
    };
    for (const row of db.listSyncKeysWithData()) Object.assign(keyFor(row.key), { boards: row.boards, lists: row.lists, items: row.items });
    for (const u of users) keyFor(u.home_key).holders.push({ user_id: u.user_id, source: "home", name: null });
    for (const uk of userKeys) {
      const k = keyFor(uk.key);
      k.holders.push({ user_id: uk.user_id, source: uk.source, name: uk.name });
      k.name ??= uk.name;
    }

    const deviceCount = new Map<string, number>();
    for (const d of devices) deviceCount.set(d.user_id, (deviceCount.get(d.user_id) ?? 0) + 1);
    const keyCount = new Map<string, number>();
    for (const uk of userKeys) keyCount.set(uk.user_id, (keyCount.get(uk.user_id) ?? 0) + 1);

    return {
      root_user_id: db.findRootUser()?.user_id ?? null,
      users: users.map((u) => this.toUser(u, deviceCount.get(u.user_id) ?? 0, (keyCount.get(u.user_id) ?? 0) + 1)),
      devices,
      grants: db.listGrants().map((g) => this.toGrant(g, redemptions)),
      keys: [...keys.values()].sort((a, b) => a.tag.localeCompare(b.tag)),
    };
  }

  userDetail(userId: string): ConsoleUserDetail | null {
    const db = this.o.db;
    const u = db.getUser(userId);
    if (!u) return null;
    const devices = this.devices().filter((d) => d.user_id === userId);
    const userKeys = db.listAllUserKeys().filter((k) => k.user_id === userId);
    const redemptions = this.redemptionsByGrant();
    const grants = db.listGrants().map((g) => this.toGrant(g, redemptions));
    return {
      user: this.toUser(u, devices.length, userKeys.length + 1),
      devices,
      keys: [
        { tag: keyTag(u.home_key), name: "(home)", source: "home" },
        ...userKeys.map((k) => ({ tag: keyTag(k.key), name: k.name, source: k.source })),
      ],
      grants_issued: grants.filter((g) => g.issuer_user_id === userId),
      redeemed: grants.filter((g) => g.redemptions.some((r) => r.user_id === userId)),
      events: db.queryAuthEvents({ userId, limit: 200 }),
    };
  }

  integrations(): ConsoleIntegrations {
    const now = this.now();
    const results = new Map(this.o.db.getIntegrationResultStats(now, 60 * 60 * 1000).map((r) => [r.integration_id, r]));
    const sinceRestart = this.o.monitor.startedAt > lastUtcMidnight(now);
    const modules = this.o.runner.snapshot().map((s) => {
      const series = this.o.monitor.moduleSeries(s.id);
      const r = results.get(s.id);
      const exhausted = s.daily_limit !== null && s.calls_today >= s.daily_limit;
      return {
        id: s.id, name: s.name, active: s.active,
        queued_edit: s.queued_edit, queued_refresh: s.queued_refresh, running: s.running, max_concurrent: s.max_concurrent,
        calls_today: s.calls_today, daily_limit: s.daily_limit,
        top_keys: s.per_key.slice(0, 5).map((k) => ({ key_tag: keyTag(k.key), count: k.count })),
        daily_limit_per_key: s.daily_limit_per_key,
        counts_since_restart: sinceRestart,
        calls_per_minute: series.calls, errors_per_minute: series.errors,
        latency_p50_ms: series.p50, latency_p95_ms: series.p95,
        results: r
          ? { by_status: r.by_status, quota_waits: r.quota_waits, retries_pending: r.retries_pending, refreshes_due: r.refreshes_due }
          : { by_status: {}, quota_waits: 0, retries_pending: 0, refreshes_due: 0 },
        quota_resets_at: exhausted ? lastUtcMidnight(now) + DAY_MS : null,
        errors_last_5m: series.errorsLast5m,
      };
    });
    const imp = this.o.monitor.importStats;
    const lat = imp.latency.percentiles(now);
    return {
      modules,
      import: {
        configured: this.o.importTiers.length > 0,
        tiers: this.o.importTiers.map((t) => t.map((m) => m.model)),
        calls: imp.calls, ok: imp.ok, failed: imp.failed,
        calls_per_minute: imp.series.series(now),
        latency_p50_ms: lat.p50, latency_p95_ms: lat.p95,
        last_error: imp.lastError, last_at: imp.lastAt,
      },
    };
  }

  private portsSync(): ConsolePorts {
    const monitor = this.o.monitor;
    const addr = this.o.httpServer.address() as AddressInfo | null;
    const perIp = new Map<string, number>();
    for (const c of monitor.open.values()) perIp.set(c.ip, (perIp.get(c.ip) ?? 0) + 1);
    const { cert, error } = this.cert();
    return {
      variant: this.o.variant,
      server_id: this.o.db.getServerId(),
      started_at: monitor.startedAt,
      listeners: addr ? [{ address: addr.address, port: addr.port, protocol: this.o.tls ? "https" : "http", routes: ROUTES }] : [],
      cert,
      cert_error: error,
      websockets_open: monitor.open.size,
      per_ip: [...perIp.entries()].map(([ip, count]) => ({ ip, count })).sort((a, b) => b.count - a.count),
      rejected_upgrades: { ...monitor.rejectedUpgrades },
      rate_limit_closes: monitor.rateLimitCloses,
      allowed_origins: this.o.allowedOrigins,
      external: this.probes,
    };
  }

  async ports(): Promise<ConsolePorts> {
    if (this.o.externalUrls.length > 0 && this.now() - this.probedAt > PROBE_TTL_MS) {
      this.probing ??= this.probeAll().finally(() => { this.probing = null; });
      await this.probing;
    }
    return this.portsSync();
  }

  private async probeAll(): Promise<void> {
    this.probes = await Promise.all(this.o.externalUrls.map((u) => this.probe(u)));
    this.probedAt = this.now();
  }

  private async probe(url: string): Promise<ConsoleExternalProbe> {
    const checkedAt = this.now();
    let status: number | null = null;
    let error: string | null = null;
    let ok = false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      status = res.status;
      ok = res.ok && (await res.text()).includes("Listr sync server running");
      if (!ok) error = res.ok ? "Unexpected response body" : `HTTP ${res.status}`;
    } catch (err) {
      const cause = (err as { cause?: { message?: string } }).cause?.message;
      error = cause ?? (err instanceof Error ? err.message : String(err));
    }
    let cert: ConsoleCert | null = null;
    const parsed = new URL(url);
    if (parsed.protocol === "https:") cert = await this.peerCert(parsed.hostname, Number(parsed.port) || 443).catch(() => null);
    return { url, ok, status, error, cert, checked_at: checkedAt };
  }

  private peerCert(host: string, port: number): Promise<ConsoleCert | null> {
    return new Promise((resolvePeer, reject) => {
      const socket = tlsConnect({ host, port, servername: host, rejectUnauthorized: false }, () => {
        const c = socket.getPeerCertificate();
        socket.end();
        resolvePeer(c && c.valid_to ? peerCertInfo(c, this.now()) : null);
      });
      socket.setTimeout(PROBE_TIMEOUT_MS, () => { socket.destroy(); reject(new Error("timeout")); });
      socket.on("error", reject);
    });
  }

  clients(): ConsoleClients {
    const db = this.o.db;
    const monitor = this.o.monitor;
    const registered = db.listAllClients();
    const registeredIds = new Set(registered.map((c) => c.client_id));
    const users = new Map(db.listAllUsers().map((u) => [u.user_id, u]));
    const openByClient = new Map<string, ConnRecord[]>();
    const unregistered: ConnRecord[] = [];
    for (const c of monitor.open.values()) {
      if (c.clientId && registeredIds.has(c.clientId)) {
        const list = openByClient.get(c.clientId) ?? [];
        list.push(c);
        openByClient.set(c.clientId, list);
      } else {
        unregistered.push(c);
      }
    }

    const liveFields = (conns: ConnRecord[]) => {
      const newest = conns.reduce((a, b) => (b.openedAt > a.openedAt ? b : a));
      const rates = conns.map((c) => monitor.msgsPerMinute(c));
      return {
        sockets: conns.length,
        connected_since: Math.min(...conns.map((c) => c.openedAt)),
        conn_state: newest.state, protocol: newest.protocol, ip: newest.ip, origin: newest.origin,
        user_agent: newest.userAgent,
        keys: new Set(conns.flatMap((c) => c.syncKeys)).size,
        msgs_in_per_min: rates.reduce((n, r) => n + r.in, 0),
        msgs_out_per_min: rates.reduce((n, r) => n + r.out, 0),
      };
    };
    const offline = {
      sockets: 0, connected_since: null, conn_state: null, protocol: null, ip: null, origin: null,
      user_agent: null, keys: 0, msgs_in_per_min: 0, msgs_out_per_min: 0,
    };

    const rows: ConsoleClientRow[] = registered.map((c) => {
      const conns = openByClient.get(c.client_id);
      const user = users.get(c.user_id);
      return {
        client_id: c.client_id, conn_id: null, registered: true, label: c.label, user_id: c.user_id,
        user_name: user?.display_name ?? null,
        effective_state: (db.getEffectiveState(c.user_id) ?? null) as ConsoleUserState | null,
        last_seen: conns ? this.now() : c.last_seen,
        ...(conns ? liveFields(conns) : offline),
      };
    });
    for (const c of unregistered) {
      rows.push({
        client_id: c.clientId, conn_id: c.id, registered: false, label: null, user_id: null, user_name: null,
        effective_state: null, last_seen: this.now(), ...liveFields([c]),
      });
    }
    rows.sort((a, b) => (b.sockets > 0 ? 1 : 0) - (a.sockets > 0 ? 1 : 0) || (b.last_seen ?? 0) - (a.last_seen ?? 0));

    return {
      counts: {
        registered: registered.length,
        connected: openByClient.size,
        unauthenticated: unregistered.length,
        failed_auth_last_hour: monitor.failedAuthsSince(60 * 60 * 1000),
      },
      rows,
    };
  }

  /** `id` is a client id, or `conn-<n>` for a socket with no registered client. */
  clientDetail(id: string): ConsoleClientDetail | null {
    const db = this.o.db;
    const monitor = this.o.monitor;
    let conns: ConnRecord[];
    let clientId: string | null;
    const connMatch = id.match(/^conn-(\d+)$/);
    if (connMatch) {
      const c = monitor.connection(Number(connMatch[1]));
      if (!c) return null;
      conns = [c];
      clientId = c.clientId;
    } else {
      clientId = id;
      conns = monitor.connectionsFor(id);
    }
    const row = clientId ? db.getClientById(clientId) : null;
    if (!row && conns.length === 0) return null;

    let client: ConsoleClientDetail["client"] = null;
    if (row) {
      const user = db.getUser(row.user_id);
      const grant = db.listGrantRedemptions().find((r) => r.client_id === row.client_id);
      let jwk: unknown = row.pubkey_jwk;
      try { jwk = JSON.parse(row.pubkey_jwk); } catch { /* keep the raw text */ }
      client = {
        client_id: row.client_id, pubkey_jwk: jwk, label: row.label, created_at: row.created_at,
        last_seen: row.last_seen, user_id: row.user_id, user_name: user?.display_name ?? null,
        effective_state: (db.getEffectiveState(row.user_id) ?? null) as ConsoleUserState | null,
        registered_by_grant: grant?.grant_id ?? null,
      };
    }

    const current = conns[0] ?? null;
    const names = new Map<string, string | null>();
    if (row) for (const k of db.getUserKeys(row.user_id)) names.set(k.key, k.name);
    const homeKey = row ? db.getUser(row.user_id)?.home_key : undefined;
    const errors = conns.flatMap((c) => c.errors).sort((a, b) => b.at - a.at).slice(0, 50);

    return {
      client,
      client_id: clientId,
      connections: conns.map(connToWire),
      keys: (current?.syncKeys ?? []).map((k) => ({
        tag: keyTag(k), name: k === homeKey ? "(home)" : names.get(k) ?? null, since: current?.cursors.get(k) ?? null,
      })),
      traffic: current
        ? { in: current.msgsIn, out: current.msgsOut, pushes: current.pushes, bytes_in: current.bytesIn, bytes_out: current.bytesOut }
        : { in: {}, out: {}, pushes: {}, bytes_in: 0, bytes_out: 0 },
      pulls: current?.pulls ?? [],
      tokens: current?.tokens ?? [],
      token_burst: this.o.tokenBurst,
      log: current ? [...current.log].reverse() : [],
      errors,
    };
  }
}
