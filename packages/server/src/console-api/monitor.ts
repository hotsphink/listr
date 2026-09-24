/**
 * In-memory live state for the operator console: open and recent sync
 * connections, integration runs with their HTTP traffic, screenshot-import
 * stats, and listener counters. Everything is bounded and resets on restart.
 * The Server-Sent Events fan-out to open console tabs also lives here.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ConsoleConnState, ConsoleConnection, ConsoleMessageLogEntry, ConsolePull, ConsoleRequest,
  ConsoleRunDetail, ConsoleRunOutcome, ConsoleRunSummary, ConsoleSeries, ConsoleTopic,
} from "@listr/shared";
import type { Priority, RunObserver, RunOutcome } from "../integration-runner.js";

const MINUTE_MS = 60_000;
const SERIES_MINUTES = 60;
const LATENCY_WINDOW_MS = 15 * MINUTE_MS;
const MAX_LATENCY_SAMPLES = 5000;

const MAX_RUNS = 500;
const MAX_BODY_CHARS = 64 * 1024;
const MAX_TOTAL_BODY_CHARS = 16 * 1024 * 1024;

const MAX_LOG = 200;
const CLOSED_LOG = 50;
const MAX_ERRORS = 50;
const MAX_PULLS = 20;
const MAX_TOKEN_SAMPLES = 60;
const MAX_CLOSED_PER_CLIENT = 20;
const MAX_CLOSED_TOTAL = 1000;
const RATE_WINDOW_MS = MINUTE_MS;

const MAX_REPLAY = 200;
const STATS_INTERVAL_MS = 1000;
const HEARTBEAT_MS = 25_000;

/** First six characters, the same short form the server log uses. */
export const keyTag = (key: string): string => key.slice(0, 6);

/** Counts per minute over the last hour. */
export class MinuteSeries {
  private buckets = new Map<number, number>();

  add(now: number, n = 1): void {
    const minute = Math.floor(now / MINUTE_MS);
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + n);
    if (this.buckets.size > SERIES_MINUTES + 5) {
      for (const k of this.buckets.keys()) if (k <= minute - SERIES_MINUTES) this.buckets.delete(k);
    }
  }

  sumSince(now: number, ms: number): number {
    const from = Math.floor((now - ms) / MINUTE_MS);
    let total = 0;
    for (const [k, v] of this.buckets) if (k > from) total += v;
    return total;
  }

  series(now: number): ConsoleSeries {
    const last = Math.floor(now / MINUTE_MS);
    const first = last - SERIES_MINUTES + 1;
    const values: number[] = [];
    for (let m = first; m <= last; m++) values.push(this.buckets.get(m) ?? 0);
    return { start: first * MINUTE_MS, bucket_ms: MINUTE_MS, values };
  }
}

/** Recent durations, for p50 and p95. */
export class LatencyWindow {
  private samples: { at: number; ms: number }[] = [];

  add(at: number, ms: number): void {
    this.samples.push({ at, ms });
    if (this.samples.length > MAX_LATENCY_SAMPLES) this.samples.splice(0, this.samples.length - MAX_LATENCY_SAMPLES);
  }

  percentiles(now: number): { p50: number | null; p95: number | null } {
    const cutoff = now - LATENCY_WINDOW_MS;
    while (this.samples.length && this.samples[0].at < cutoff) this.samples.shift();
    if (this.samples.length === 0) return { p50: null, p95: null };
    const sorted = this.samples.map((s) => s.ms).sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { p50: at(0.5), p95: at(0.95) };
  }
}

function pushBounded<T>(arr: T[], value: T, max: number): void {
  arr.push(value);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// -- Connections --------------------------------------------------------------

export interface ConnRecord {
  id: number;
  ip: string;
  origin: string | null;
  userAgent: string | null;
  openedAt: number;
  closedAt: number | null;
  closeCode: number | null;
  closeReason: string | null;
  protocol: number | null;
  state: ConsoleConnState;
  clientId: string | null;
  userId: string | null;
  syncKeys: string[];
  msgsIn: Record<string, number>;
  msgsOut: Record<string, number>;
  pushes: Record<string, number>;
  bytesIn: number;
  bytesOut: number;
  recentIn: number[];
  recentOut: number[];
  log: ConsoleMessageLogEntry[];
  errors: { at: number; message: string; reason: string | null }[];
  pulls: ConsolePull[];
  cursors: Map<string, number>;
  tokens: { at: number; level: number }[];
}

export function connToWire(c: ConnRecord): ConsoleConnection {
  return {
    id: c.id, client_id: c.clientId, ip: c.ip, origin: c.origin, user_agent: c.userAgent,
    opened_at: c.openedAt, closed_at: c.closedAt, close_code: c.closeCode, close_reason: c.closeReason,
    protocol: c.protocol, state: c.state,
  };
}

function countRecent(times: number[], now: number): number {
  const cutoff = now - RATE_WINDOW_MS;
  while (times.length && times[0] < cutoff) times.shift();
  return times.length;
}

// Every outgoing message is JSON.stringify of an object whose first key is
// `type`, so the type can be read without parsing a possibly huge snapshot.
const OUT_TYPE = /^\{"type":"([a-z_]+)"/;

// -- Integration runs ---------------------------------------------------------

interface RunRecord {
  id: number;
  module: string;
  itemId: string;
  boardId: string;
  syncKey: string;
  priority: Priority;
  attempt: number;
  inputs: unknown;
  resultBefore: unknown;
  startedAt: number;
  finishedAt: number | null;
  outcome: ConsoleRunOutcome;
  error: string | null;
  requests: ConsoleRequest[];
  output: ConsoleRunDetail["output"];
  resultAfter: unknown;
  broadcast: boolean;
}

interface ModuleStats {
  calls: MinuteSeries;
  errors: MinuteSeries;
  latency: LatencyWindow;
}

// -- SSE ------------------------------------------------------------------------

interface Subscriber {
  res: ServerResponse;
}

interface BufferedEvent {
  id: number;
  topic: ConsoleTopic;
  json: string;
}

type StatsTopic = "trust" | "integration.stats" | "client.stats" | "ports.stats";

export class Monitor {
  readonly startedAt: number;
  private now: () => number;

  // Connections
  private nextConnId = 1;
  readonly open = new Map<number, ConnRecord>();
  private closed: ConnRecord[] = [];
  private closedByClient = new Map<string, ConnRecord[]>();
  readonly rejectedUpgrades: Record<string, number> = {};
  rateLimitCloses = 0;
  private failedAuths: number[] = [];

  // Integrations
  private nextRunId = 1;
  private runs: RunRecord[] = [];
  private runsById = new Map<number, RunRecord>();
  private bodyChars = 0;
  private moduleStats = new Map<string, ModuleStats>();
  captureBodies: boolean;

  // Screenshot import
  readonly importStats = {
    calls: 0, ok: 0, failed: 0, series: new MinuteSeries(), latency: new LatencyWindow(),
    lastError: null as string | null, lastAt: null as number | null,
  };

  // SSE
  private subscribers = new Set<Subscriber>();
  private nextEventId = 1;
  private replay: BufferedEvent[] = [];
  private dirty = new Set<StatsTopic>();
  private statsProviders = new Map<StatsTopic, () => unknown>();
  private statsTimer: ReturnType<typeof setInterval>;
  private heartbeatTimer: ReturnType<typeof setInterval>;

  constructor(opts: { now?: () => number; captureBodies?: boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
    this.captureBodies = opts.captureBodies ?? true;
    this.statsTimer = setInterval(() => this.flushStats(), STATS_INTERVAL_MS);
    this.statsTimer.unref();
    this.heartbeatTimer = setInterval(() => {
      for (const s of this.subscribers) s.res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref();
  }

  stop(): void {
    clearInterval(this.statsTimer);
    clearInterval(this.heartbeatTimer);
    for (const s of this.subscribers) s.res.end();
    this.subscribers.clear();
  }

  // -- Connection hooks ---------------------------------------------------------

  connOpened(req: IncomingMessage): ConnRecord {
    const origin = req.headers.origin;
    const ua = req.headers["user-agent"];
    const conn: ConnRecord = {
      id: this.nextConnId++,
      ip: req.socket.remoteAddress ?? "unknown",
      origin: typeof origin === "string" ? origin : null,
      userAgent: typeof ua === "string" ? ua : null,
      openedAt: this.now(), closedAt: null, closeCode: null, closeReason: null,
      protocol: null, state: "connecting", clientId: null, userId: null, syncKeys: [],
      msgsIn: {}, msgsOut: {}, pushes: {}, bytesIn: 0, bytesOut: 0, recentIn: [], recentOut: [],
      log: [], errors: [], pulls: [], cursors: new Map(), tokens: [],
    };
    this.open.set(conn.id, conn);
    this.markDirty("ports.stats");
    this.markDirty("client.stats");
    return conn;
  }

  connChallenged(conn: ConnRecord, clientId: string, protocol: number): void {
    conn.clientId = clientId;
    conn.protocol = protocol;
    conn.state = "challenged";
  }

  connProtocol(conn: ConnRecord, protocol: number): void {
    conn.protocol = protocol;
  }

  connNeedsGrant(conn: ConnRecord): void {
    conn.state = "needs_grant";
    this.emit("client.connect", { conn_id: conn.id, client_id: conn.clientId, state: conn.state });
    this.markDirty("client.stats");
  }

  connAuthenticated(conn: ConnRecord, userId: string, syncKeys: string[]): void {
    conn.state = "authenticated";
    conn.userId = userId;
    conn.syncKeys = [...syncKeys];
    this.emit("client.connect", { conn_id: conn.id, client_id: conn.clientId, state: conn.state });
    this.markDirty("client.stats");
  }

  connKeys(conn: ConnRecord, syncKeys: string[]): void {
    conn.syncKeys = [...syncKeys];
  }

  authFailed(conn: ConnRecord, reason: string): void {
    pushBounded(this.failedAuths, this.now(), 10_000);
    pushBounded(conn.errors, { at: this.now(), message: `auth failed: ${reason}`, reason }, MAX_ERRORS);
  }

  failedAuthsSince(ms: number): number {
    const cutoff = this.now() - ms;
    return this.failedAuths.filter((t) => t >= cutoff).length;
  }

  messageIn(conn: ConnRecord, bytes: number, msg: { type?: unknown; entity_type?: unknown; data?: { id?: unknown }; entity_id?: unknown }): void {
    const now = this.now();
    const type = typeof msg.type === "string" ? msg.type : "?";
    conn.msgsIn[type] = (conn.msgsIn[type] ?? 0) + 1;
    conn.bytesIn += bytes;
    pushBounded(conn.recentIn, now, 10_000);
    let detail: string | null = null;
    if (type === "push_entity" || type === "push_delete") {
      const entityType = typeof msg.entity_type === "string" ? msg.entity_type : "?";
      const id = type === "push_entity" ? msg.data?.id : msg.entity_id;
      detail = `${entityType} ${typeof id === "string" ? id : "?"}`;
      if (type === "push_entity") conn.pushes[entityType] = (conn.pushes[entityType] ?? 0) + 1;
    }
    pushBounded(conn.log, { at: now, dir: "in", type, bytes, detail }, MAX_LOG);
    this.markDirty("client.stats");
  }

  messageOut(conn: ConnRecord, data: unknown): void {
    const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString() : "";
    const bytes = Buffer.byteLength(text);
    const type = OUT_TYPE.exec(text)?.[1] ?? "?";
    const now = this.now();
    conn.msgsOut[type] = (conn.msgsOut[type] ?? 0) + 1;
    conn.bytesOut += bytes;
    pushBounded(conn.recentOut, now, 10_000);
    let detail: string | null = null;
    if (type === "error") {
      try {
        const parsed = JSON.parse(text) as { message?: string; reason?: string };
        pushBounded(conn.errors, { at: now, message: parsed.message ?? "", reason: parsed.reason ?? null }, MAX_ERRORS);
        detail = parsed.reason ?? parsed.message ?? null;
      } catch {
        // Not JSON after all. Count it and move on.
      }
    }
    pushBounded(conn.log, { at: now, dir: "out", type, bytes, detail }, MAX_LOG);
  }

  tokenLevel(conn: ConnRecord, level: number): void {
    const now = this.now();
    const last = conn.tokens[conn.tokens.length - 1];
    if (last && now - last.at < 1000) return;
    pushBounded(conn.tokens, { at: now, level: Math.floor(level) }, MAX_TOKEN_SAMPLES);
  }

  pull(conn: ConnRecord, keysSince: { key: string; since: number }[], counts: Record<string, number>): void {
    for (const { key, since } of keysSince) conn.cursors.set(key, since);
    pushBounded(conn.pulls, { at: this.now(), keys: keysSince.length, counts }, MAX_PULLS);
  }

  upgradeRejected(reason: string): void {
    this.rejectedUpgrades[reason] = (this.rejectedUpgrades[reason] ?? 0) + 1;
    this.markDirty("ports.stats");
  }

  rateLimited(conn: ConnRecord): void {
    this.rateLimitCloses++;
    pushBounded(conn.errors, { at: this.now(), message: "closed: rate limit exceeded", reason: "rate_limit" }, MAX_ERRORS);
  }

  connClosed(conn: ConnRecord, code: number, reason: string): void {
    conn.closedAt = this.now();
    conn.closeCode = code;
    conn.closeReason = reason || null;
    conn.state = "closed";
    if (conn.log.length > CLOSED_LOG) conn.log.splice(0, conn.log.length - CLOSED_LOG);
    this.open.delete(conn.id);
    pushBounded(this.closed, conn, MAX_CLOSED_TOTAL);
    if (conn.clientId) {
      const list = this.closedByClient.get(conn.clientId) ?? [];
      pushBounded(list, conn, MAX_CLOSED_PER_CLIENT);
      this.closedByClient.set(conn.clientId, list);
    }
    this.emit("client.disconnect", { conn_id: conn.id, client_id: conn.clientId });
    this.markDirty("ports.stats");
    this.markDirty("client.stats");
  }

  msgsPerMinute(conn: ConnRecord): { in: number; out: number } {
    const now = this.now();
    return { in: countRecent(conn.recentIn, now), out: countRecent(conn.recentOut, now) };
  }

  /** Open connections, then closed ones newest first, for one client. */
  connectionsFor(clientId: string): ConnRecord[] {
    const open = [...this.open.values()].filter((c) => c.clientId === clientId);
    const closed = [...(this.closedByClient.get(clientId) ?? [])].reverse();
    return [...open, ...closed];
  }

  connection(id: number): ConnRecord | null {
    return this.open.get(id) ?? this.closed.find((c) => c.id === id) ?? null;
  }

  // -- Integration runs -----------------------------------------------------------

  private statsFor(module: string): ModuleStats {
    let s = this.moduleStats.get(module);
    if (!s) {
      s = { calls: new MinuteSeries(), errors: new MinuteSeries(), latency: new LatencyWindow() };
      this.moduleStats.set(module, s);
    }
    return s;
  }

  moduleSeries(module: string) {
    const s = this.statsFor(module);
    const now = this.now();
    const { p50, p95 } = s.latency.percentiles(now);
    return {
      calls: s.calls.series(now),
      errors: s.errors.series(now),
      errorsLast5m: s.errors.sumSince(now, 5 * MINUTE_MS),
      p50, p95,
    };
  }

  /** The runner's view of this monitor. */
  readonly runObserver: RunObserver = {
    captureBodies: () => this.captureBodies,
    runStarted: (info) => {
      const run: RunRecord = {
        id: this.nextRunId++, module: info.module, itemId: info.itemId, boardId: info.boardId,
        syncKey: info.syncKey, priority: info.priority, attempt: info.attempt, inputs: info.inputs,
        resultBefore: info.resultBefore, startedAt: this.now(), finishedAt: null, outcome: "running",
        error: null, requests: [], output: null, resultAfter: null, broadcast: false,
      };
      this.runs.push(run);
      this.runsById.set(run.id, run);
      while (this.runs.length > MAX_RUNS) this.evictRun(this.runs.shift()!);
      this.emit("integration.run", this.runSummary(run));
      this.markDirty("integration.stats");
      return run.id;
    },
    requestStarted: (runId, info) => {
      const run = this.runsById.get(runId);
      if (!run) return -1;
      run.requests.push({
        method: info.method, url: info.url, request_headers: info.headers, started_at: this.now(),
        duration_ms: null, status: null, response_headers: null, body: null, body_bytes: null,
        body_truncated: false, body_dropped: false, error: null,
      });
      this.statsFor(run.module).calls.add(this.now());
      return run.requests.length - 1;
    },
    requestFinished: (runId, reqIndex, info) => {
      const req = this.runsById.get(runId)?.requests[reqIndex];
      if (!req) return;
      const now = this.now();
      req.duration_ms = now - req.started_at;
      req.status = info.status;
      req.response_headers = info.headers;
      req.body_bytes = info.bodyBytes;
      if (info.body !== null) {
        req.body_truncated = info.body.length > MAX_BODY_CHARS;
        req.body = req.body_truncated ? info.body.slice(0, MAX_BODY_CHARS) : info.body;
        this.bodyChars += req.body.length;
        this.enforceBodyBudget();
      }
      this.statsFor(this.runsById.get(runId)!.module).latency.add(now, req.duration_ms);
    },
    requestFailed: (runId, reqIndex, error) => {
      const req = this.runsById.get(runId)?.requests[reqIndex];
      if (!req) return;
      req.duration_ms = this.now() - req.started_at;
      req.error = error;
    },
    runFinished: (runId, info) => {
      const run = this.runsById.get(runId);
      if (!run) return;
      run.finishedAt = this.now();
      run.outcome = info.outcome as RunOutcome;
      run.error = info.error;
      run.output = info.output;
      run.resultAfter = info.resultAfter;
      run.broadcast = info.broadcast;
      if (info.outcome === "error" || info.outcome === "config_error") this.statsFor(run.module).errors.add(this.now());
      this.emit("integration.run", this.runSummary(run));
      this.markDirty("integration.stats");
    },
  };

  private evictRun(run: RunRecord): void {
    this.runsById.delete(run.id);
    for (const r of run.requests) if (r.body) this.bodyChars -= r.body.length;
  }

  // Drop the oldest bodies first, keeping their metadata.
  private enforceBodyBudget(): void {
    for (const run of this.runs) {
      if (this.bodyChars <= MAX_TOTAL_BODY_CHARS) return;
      for (const r of run.requests) {
        if (!r.body) continue;
        this.bodyChars -= r.body.length;
        r.body = null;
        r.body_dropped = true;
      }
    }
  }

  runSummary(run: RunRecord): ConsoleRunSummary {
    return {
      id: run.id, module: run.module, item_id: run.itemId, key_tag: keyTag(run.syncKey), priority: run.priority,
      started_at: run.startedAt, duration_ms: run.finishedAt === null ? null : run.finishedAt - run.startedAt,
      request_count: run.requests.length, outcome: run.outcome, error: run.error,
    };
  }

  listRuns(filter: { module?: string; outcome?: string; key?: string; item?: string; beforeId?: number; limit?: number }): ConsoleRunSummary[] {
    const out: ConsoleRunSummary[] = [];
    const limit = filter.limit ?? 100;
    for (let i = this.runs.length - 1; i >= 0 && out.length < limit; i--) {
      const run = this.runs[i];
      if (filter.beforeId !== undefined && run.id >= filter.beforeId) continue;
      if (filter.module && run.module !== filter.module) continue;
      if (filter.outcome && run.outcome !== filter.outcome) continue;
      if (filter.key && !run.syncKey.startsWith(filter.key)) continue;
      if (filter.item && !run.itemId.startsWith(filter.item)) continue;
      out.push(this.runSummary(run));
    }
    return out;
  }

  runDetail(id: number): ConsoleRunDetail | null {
    const run = this.runsById.get(id);
    if (!run) return null;
    return {
      ...this.runSummary(run), board_id: run.boardId, attempt: run.attempt, inputs: run.inputs,
      requests: run.requests, output: run.output, result_before: run.resultBefore,
      result_after: run.resultAfter, broadcast: run.broadcast,
    };
  }

  // -- Screenshot import ------------------------------------------------------------

  importFinished(startedAt: number, error: string | null): void {
    const now = this.now();
    const s = this.importStats;
    s.calls++;
    s.series.add(now);
    s.latency.add(now, now - startedAt);
    s.lastAt = now;
    if (error === null) s.ok++;
    else { s.failed++; s.lastError = error; }
    this.markDirty("integration.stats");
  }

  // -- SSE ----------------------------------------------------------------------------

  setStatsProvider(topic: StatsTopic, provider: () => unknown): void {
    this.statsProviders.set(topic, provider);
  }

  markDirty(topic: StatsTopic): void {
    this.dirty.add(topic);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  emit(topic: ConsoleTopic, data: unknown): void {
    const event: BufferedEvent = { id: this.nextEventId++, topic, json: JSON.stringify(data ?? null) };
    pushBounded(this.replay, event, MAX_REPLAY);
    for (const s of this.subscribers) this.write(s, event);
  }

  private write(s: Subscriber, e: BufferedEvent): void {
    s.res.write(`id: ${e.id}\nevent: ${e.topic}\ndata: ${e.json}\n\n`);
  }

  private flushStats(): void {
    if (this.dirty.size === 0) return;
    if (this.subscribers.size === 0) {
      this.dirty.clear();
      return;
    }
    const topics = [...this.dirty];
    this.dirty.clear();
    for (const topic of topics) {
      const provider = this.statsProviders.get(topic);
      let data: unknown = null;
      try {
        data = provider ? provider() : null;
      } catch (err) {
        console.error(`[console] ${topic} stats failed:`, err);
        continue;
      }
      this.emit(topic, data);
    }
  }

  subscribe(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const lastId = Number(req.headers["last-event-id"]);
    if (Number.isFinite(lastId)) {
      for (const e of this.replay) if (e.id > lastId) res.write(`id: ${e.id}\nevent: ${e.topic}\ndata: ${e.json}\n\n`);
    }
    const sub: Subscriber = { res };
    this.subscribers.add(sub);
    const drop = () => this.subscribers.delete(sub);
    req.on("close", drop);
    res.on("close", drop);
  }
}
