import { parse as parseToml } from "smol-toml";
import {
  coerceValue, computeOverlay, orderResults, withOverlay,
  type Board, type Integration, type IntegrationResult, type Item, type List,
} from "@listr/shared";
import type { IntegrationModule, IntegrationRunResult } from "./integrations/types.js";
import type { IntegrationServerConfig } from "./config.js";
import { toWireResult, type IntegrationResultRow, type createDbApi } from "./db.js";
import { redact, redactText } from "./redact.js";

type DbApi = ReturnType<typeof createDbApi>;
type BroadcastFn = (syncKey: string, sender: null, msg: unknown) => void;
export type Priority = "edit" | "refresh";

const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 5;
const RETRY_BASE_MS = 60_000;
const RETRY_CAP_MS = 6 * 60 * 60 * 1000;
const TICK_MS = 60_000;

export interface RunnerOptions {
  now?: () => number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** How often to look for due retries and refreshes. 0 disables the timer. */
  tickMs?: number;
  observer?: RunObserver;
}

export type RunOutcome = "complete" | "not_found" | "ambiguous" | "error" | "quota" | "stale" | "config_error";

/** Watches runs and their HTTP requests, for the console. Everything it is handed is already redacted. */
export interface RunObserver {
  /** Whether to read response bodies. */
  captureBodies(): boolean;
  runStarted(info: {
    module: string; itemId: string; boardId: string; syncKey: string; priority: Priority;
    attempt: number; inputs: unknown; resultBefore: unknown;
  }): number;
  requestStarted(runId: number, info: { method: string; url: string; headers: Record<string, string> }): number;
  requestFinished(runId: number, reqIndex: number, info: {
    status: number; headers: Record<string, string>; body: string | null; bodyBytes: number | null;
  }): void;
  requestFailed(runId: number, reqIndex: number, error: string): void;
  runFinished(runId: number, info: {
    outcome: RunOutcome; error: string | null; resultAfter: unknown; broadcast: boolean;
    output: {
      status: string; raw_values: Record<string, unknown>; attribute_values: Record<string, unknown>;
      dropped: string[]; choices: unknown; refresh_at: number | null;
    } | null;
  }): void;
}

/** One module's queue and budget, as the console shows it. */
export interface ModuleSnapshot {
  id: string;
  name: string;
  active: boolean;
  queued_edit: number;
  queued_refresh: number;
  running: number;
  max_concurrent: number;
  calls_today: number;
  daily_limit: number | null;
  per_key: { key: string; count: number }[];
  daily_limit_per_key: number | null;
}

interface Job {
  key: string;
  itemId: string;
  module: IntegrationModule;
  priority: Priority;
  /** Modules already run in this cascade, so they don't run again. */
  chain: Set<string>;
  running: boolean;
  /** Triggered again while running. Rerun when done. */
  dirty: boolean;
}

class QuotaError extends Error {}

/** Key-sorted JSON, so equal inputs always compare equal. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Runs integration modules for items and stores what they produce on
 * integration_results rows. It never writes items: clients overlay the
 * results when they read.
 */
export class IntegrationRunner {
  private jobs = new Map<string, Job>();
  private queues = new Map<string, Job[]>();
  private running = new Map<string, number>();
  private usage = new Map<string, { day: number; count: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private idleWaiters: (() => void)[] = [];
  private now: () => number;
  private fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private db: DbApi,
    private modules: Map<string, IntegrationModule>,
    private serverConfig: Record<string, IntegrationServerConfig>,
    private broadcast: BroadcastFn,
    private opts: RunnerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Modules the server offers, with each one's active flag. Only configured modules are listed. */
  describe() {
    return [...this.modules.values()]
      .filter((m) => this.serverConfig[m.id] !== undefined)
      .map((m) => ({
        id: m.id,
        name: m.name,
        attributes: m.attributes,
        config_template: m.configTemplate,
        active: m.isActive(this.settings(m)),
      }));
  }

  /** Queue, concurrency and daily budget for each configured module. */
  snapshot(): ModuleSnapshot[] {
    const day = Math.floor(this.now() / 86_400_000);
    const today = (key: string) => {
      const u = this.usage.get(key);
      return u && u.day === day ? u.count : 0;
    };
    return [...this.modules.values()]
      .filter((m) => this.serverConfig[m.id] !== undefined)
      .map((m) => {
        const cfg = this.settings(m);
        const queue = this.queues.get(m.id) ?? [];
        const prefix = `${m.id}:`;
        const perKey = [...this.usage.entries()]
          .filter(([k, u]) => k.startsWith(prefix) && u.day === day)
          .map(([k, u]) => ({ key: k.slice(prefix.length), count: u.count }))
          .sort((a, b) => b.count - a.count);
        return {
          id: m.id,
          name: m.name,
          active: m.isActive(cfg),
          queued_edit: queue.filter((j) => j.priority === "edit").length,
          queued_refresh: queue.filter((j) => j.priority === "refresh").length,
          running: this.running.get(m.id) ?? 0,
          max_concurrent: cfg.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
          calls_today: today(m.id),
          daily_limit: cfg.daily_limit ?? null,
          per_key: perKey,
          daily_limit_per_key: cfg.daily_limit_per_key ?? null,
        };
      });
  }

  /** Requeue results a restart left unprocessed, and start the timer for due retries and refreshes. */
  start(): void {
    for (const row of this.db.getStalledIntegrationResults()) this.enqueueResult(row, "edit");
    this.tick();
    const tickMs = this.opts.tickMs ?? TICK_MS;
    if (tickMs > 0) this.timer = setInterval(() => this.tick(), tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Resolve once no job is queued or running. For tests. */
  idle(): Promise<void> {
    if (this.jobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  tick(): void {
    for (const row of this.db.getDueIntegrationResults(this.now())) this.enqueueResult(row, "refresh");
  }

  /** Queue every enabled module whose inputs changed for this item. */
  onItemChanged(itemId: string, chain: Set<string> = new Set()): void {
    const ctx = this.itemContext(itemId);
    if (!ctx) return;
    const { item, board, results } = ctx;
    for (const cfg of board.integrations ?? []) {
      if (!cfg.enabled || chain.has(cfg.integration_id)) continue;
      const module = this.modules.get(cfg.integration_id);
      if (!module) continue;
      const existing = results.find((r) => r.integration_id === module.id) as IntegrationResultRow | undefined;
      const config = this.parseConfig(cfg);
      if (!config.ok) {
        this.writeConfigError(item, module, existing, config.error);
        continue;
      }
      const inputs = module.inputsOf(item, this.effectiveFor(module, ctx), config.value);
      if (!inputs) {
        if (existing) this.removeResult(existing, item);
        continue;
      }
      if (existing && existing.inputs === canonical(inputs) && existing.status !== "unprocessed") continue;
      this.enqueue(item.id, module, "edit", chain);
    }
  }

  /** Drop an item's results. Clients drop their copies when the item's tombstone arrives. */
  onItemDeleted(itemId: string): void {
    this.db.deleteIntegrationResultsForItem(itemId);
  }

  /** Remove results for integrations the board dropped, and run ones it newly enabled. */
  onBoardChanged(board: Board, previous: Board | null): void {
    const enabled = (b: Board | null) => new Set((b?.integrations ?? []).filter((c) => c.enabled).map((c) => c.integration_id));
    const before = enabled(previous);
    const after = enabled(board);
    const now = this.now();
    for (const id of before) {
      if (after.has(id)) continue;
      for (const { id: resultId, sync_key } of this.db.getIntegrationResultIdsForBoard(board.id, id)) {
        this.db.tombstoneIntegrationResult(resultId, sync_key, now);
        this.broadcast(sync_key, null, { type: "deleted", entity_type: "integration_result", entity_id: resultId, deleted_at: now });
      }
    }
    const configChanged = (id: string) =>
      board.integrations?.find((c) => c.integration_id === id)?.config !==
      previous?.integrations?.find((c) => c.integration_id === id)?.config;
    if ([...after].some((id) => !before.has(id) || configChanged(id))) {
      for (const itemId of this.db.getItemIdsForBoard(board.id)) this.onItemChanged(itemId);
    }
  }

  // -- Queue ---------------------------------------------------------------

  private enqueueResult(row: IntegrationResultRow, priority: Priority): void {
    const module = this.modules.get(row.integration_id);
    if (module) this.enqueue(row.item_id, module, priority, new Set());
  }

  private enqueue(itemId: string, module: IntegrationModule, priority: Priority, chain: Set<string>): void {
    const key = `${itemId}:${module.id}`;
    const job = this.jobs.get(key);
    if (job) {
      if (job.running) job.dirty = true;
      if (priority === "edit" && job.priority === "refresh") {
        job.priority = "edit";
        if (!job.running) this.sortQueue(module.id);
      }
      job.chain = chain;
      return;
    }
    const fresh: Job = { key, itemId, module, priority, chain, running: false, dirty: false };
    this.jobs.set(key, fresh);
    const queue = this.queues.get(module.id) ?? [];
    this.queues.set(module.id, queue);
    queue.push(fresh);
    this.sortQueue(module.id);
    this.pump(module);
  }

  private sortQueue(moduleId: string): void {
    // Stable sort: edits ahead of refreshes, FIFO within each.
    this.queues.get(moduleId)?.sort((a, b) => (a.priority === b.priority ? 0 : a.priority === "edit" ? -1 : 1));
  }

  private pump(module: IntegrationModule): void {
    const queue = this.queues.get(module.id) ?? [];
    const max = this.settings(module).max_concurrent ?? DEFAULT_MAX_CONCURRENT;
    while ((this.running.get(module.id) ?? 0) < max && queue.length) {
      const job = queue.shift()!;
      job.running = true;
      this.running.set(module.id, (this.running.get(module.id) ?? 0) + 1);
      this.runJob(job)
        .catch((err) => console.error(`[integrations] ${job.key}: unexpected error:`, err))
        .finally(() => {
          this.running.set(module.id, (this.running.get(module.id) ?? 1) - 1);
          this.jobs.delete(job.key);
          if (job.dirty) this.enqueue(job.itemId, module, job.priority, job.chain);
          this.pump(module);
          if (this.jobs.size === 0) for (const w of this.idleWaiters.splice(0)) w();
        });
    }
  }

  // -- Running a job -------------------------------------------------------

  private async runJob(job: Job): Promise<void> {
    const { module } = job;
    const resultId = job.key;
    const ctx = this.itemContext(job.itemId);
    if (!ctx) {
      this.db.deleteIntegrationResultsForItem(job.itemId);
      return;
    }
    const { item, board, syncKey } = ctx;
    const existing = this.db.getIntegrationResult(resultId);
    const cfg = board.integrations?.find((c) => c.integration_id === module.id && c.enabled);
    if (!cfg) {
      if (existing) this.removeResult(existing, item);
      return;
    }
    const observer = this.opts.observer;
    const observe = (inputs: unknown) =>
      observer?.runStarted({
        module: module.id, itemId: item.id, boardId: board.id, syncKey, priority: job.priority,
        attempt: (existing?.attempts ?? 0) + 1, inputs, resultBefore: existing ? toWireResult(existing) : null,
      });
    const finish = (
      runId: number | undefined,
      outcome: RunOutcome,
      error: string | null,
      broadcast: boolean,
      output: Parameters<RunObserver["runFinished"]>[1]["output"] = null,
    ) => {
      if (runId === undefined) return;
      const after = this.db.getIntegrationResult(resultId);
      observer!.runFinished(runId, { outcome, error, output, broadcast, resultAfter: after ? toWireResult(after) : null });
    };

    const config = this.parseConfig(cfg);
    if (!config.ok) {
      const runId = observe(null);
      const broadcast = this.writeConfigError(item, module, existing, config.error);
      finish(runId, "config_error", config.error, broadcast);
      return;
    }
    const inputs = this.inputsFor(module, config.value, job.itemId);
    if (!inputs) {
      if (existing) this.removeResult(existing, item);
      return;
    }

    const now = this.now();
    const serverConfig = this.settings(module);
    const runId = observe(inputs);
    try {
      this.spend(module, syncKey, serverConfig, now);
    } catch {
      const broadcast = this.writeQuotaWait(item, module, existing, inputs, now);
      finish(runId, "quota", "daily limit reached", broadcast);
      return;
    }
    // A refresh keeps showing the old status. An edit shows the spinner while it runs.
    if (job.priority === "edit" && existing?.status !== "unprocessed") {
      this.write(item, module, existing, { ...(existing ?? this.blank(item, module)), status: "unprocessed", error: undefined });
    }

    let out: IntegrationRunResult;
    let spentFirst = true;
    try {
      out = await module.run({
        item,
        inputs,
        config: config.value,
        serverConfig,
        now,
        fetch: (url) => {
          // The first call was paid for before the run.
          if (!spentFirst) this.spend(module, syncKey, serverConfig, this.now());
          spentFirst = false;
          const init = { signal: AbortSignal.timeout(serverConfig.timeout_ms ?? DEFAULT_TIMEOUT_MS) };
          return runId === undefined ? this.fetchImpl(url, init) : this.observedFetch(runId, url, init, serverConfig);
        },
      });
    } catch (err) {
      const current = this.db.getIntegrationResult(resultId);
      if (err instanceof QuotaError) {
        const broadcast = this.writeQuotaWait(item, module, current, inputs, this.now());
        finish(runId, "quota", "daily limit reached", broadcast);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[integrations] ${module.id} failed for item ${item.id}:`, err);
      const broadcast = this.writeFailure(item, module, current, inputs, message);
      finish(runId, "error", redact(message, serverConfig), broadcast);
      return;
    }

    // Stale discard: the item changed while the call ran, so this answer may be for old inputs.
    const latestInputs = this.inputsFor(module, config.value, job.itemId);
    if (!latestInputs || canonical(latestInputs) !== canonical(inputs)) {
      if (latestInputs) job.dirty = true;
      finish(runId, "stale", null, false);
      return;
    }

    const declared = new Map(module.attributes.map((a) => [a.key, a.type]));
    const values: Record<string, unknown> = {};
    const dropped: string[] = [];
    for (const [key, raw] of Object.entries(out.attribute_values)) {
      const v = key === "title" ? (typeof raw === "string" ? raw : undefined) : declared.has(key) ? coerceValue(raw, declared.get(key)!) : undefined;
      if (v === undefined) {
        console.warn(`[integrations] ${module.id}: dropping ${key}=${JSON.stringify(raw)} for item ${item.id}`);
        dropped.push(key);
      } else values[key] = v;
    }

    const before = this.db.getIntegrationResult(resultId);
    const broadcast = this.write(item, module, before, {
      ...(before ?? this.blank(item, module)),
      status: out.status,
      attribute_values: values,
      integration_data: out.integration_data ?? {},
      choices: out.choices,
      error: undefined,
      inputs: canonical(inputs),
      attempts: 0,
      next_attempt_at: null,
      next_refresh_at: out.refresh_at ?? null,
    });
    console.log(`[integrations] ${module.id} ${out.status} for item ${item.id}`);
    finish(runId, out.status, null, broadcast, {
      status: out.status, raw_values: out.attribute_values, attribute_values: values, dropped,
      choices: out.choices ?? null, refresh_at: out.refresh_at ?? null,
    });

    // Cascade: other modules may read what this one produced.
    if (canonical(before?.attribute_values ?? {}) !== canonical(values)) {
      this.onItemChanged(item.id, new Set([...job.chain, module.id]));
    }
  }

  /** Fetch through the observer, recording a redacted copy of the request and response. */
  private async observedFetch(runId: number, url: string, init: RequestInit, cfg: IntegrationServerConfig): Promise<Response> {
    const observer = this.opts.observer!;
    const req = observer.requestStarted(runId, { method: "GET", url: redactText(url, cfg), headers: {} });
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      observer.requestFailed(runId, req, redact(err, cfg));
      throw err;
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = redactText(v, cfg); });
    let body: string | null = null;
    let bodyBytes: number | null = null;
    if (observer.captureBodies()) {
      try {
        const text = await res.clone().text();
        bodyBytes = Buffer.byteLength(text);
        body = redactText(text, cfg);
      } catch (err) {
        observer.requestFailed(runId, req, `reading body: ${redact(err, cfg)}`);
        return res;
      }
    }
    observer.requestFinished(runId, req, { status: res.status, headers, body, bodyBytes });
    return res;
  }

  private inputsFor(module: IntegrationModule, config: Record<string, unknown>, itemId: string): Record<string, unknown> | null {
    const ctx = this.itemContext(itemId);
    return ctx ? module.inputsOf(ctx.item, this.effectiveFor(module, ctx), config) : null;
  }

  /** The item with every other module's overlay applied. A module never reads its own output. */
  private effectiveFor(module: IntegrationModule, ctx: { item: Item; board: Board; results: IntegrationResult[] }): Item {
    const others = ctx.results.filter((r) => r.integration_id !== module.id);
    return withOverlay(ctx.item, computeOverlay(ctx.item, orderResults(others, ctx.board.integrations), ctx.board.schema ?? []));
  }

  // -- Budget --------------------------------------------------------------

  /** Count one external call against the module's daily limits, or throw QuotaError. */
  private spend(module: IntegrationModule, syncKey: string, cfg: IntegrationServerConfig, now: number): void {
    const day = Math.floor(now / 86_400_000);
    const counters: [string, number | undefined][] = [
      [module.id, cfg.daily_limit],
      [`${module.id}:${syncKey}`, cfg.daily_limit_per_key],
    ];
    for (const [key, limit] of counters) {
      const u = this.usage.get(key);
      const count = u && u.day === day ? u.count : 0;
      if (limit !== undefined && count >= limit) throw new QuotaError(`daily limit reached for ${key}`);
    }
    for (const [key] of counters) {
      const u = this.usage.get(key);
      this.usage.set(key, { day, count: (u && u.day === day ? u.count : 0) + 1 });
    }
  }

  // -- Writing results -----------------------------------------------------

  private blank(item: Item, module: IntegrationModule): IntegrationResultRow {
    const now = this.now();
    return {
      id: `${item.id}:${module.id}`, item_id: item.id, integration_id: module.id, status: "unprocessed",
      attribute_values: {}, integration_data: {}, created_at: now, updated_at: now,
      inputs: null, attempts: 0, next_attempt_at: null, next_refresh_at: null,
    };
  }

  /**
   * Store a result row. Bump updated_at and broadcast only when a synced
   * field changed. Scheduling columns alone are written quietly.
   */
  private write(item: Item, module: IntegrationModule, before: IntegrationResultRow | null, next: IntegrationResultRow): boolean {
    const wireBefore = before ? canonical({ ...toWireResult(before), updated_at: 0 }) : null;
    const wireAfter = canonical({ ...toWireResult(next), updated_at: 0 });
    const changed = wireBefore !== wireAfter;
    const row: IntegrationResultRow = {
      ...next,
      updated_at: changed ? Math.max(this.now(), (before?.updated_at ?? 0) + 1) : (before?.updated_at ?? next.updated_at),
    };
    this.db.putIntegrationResult(row);
    if (!changed) return false;
    const syncKey = this.db.getItemSyncKey(item.id);
    if (syncKey) this.broadcast(syncKey, null, { type: "entity", entity_type: "integration_result", data: toWireResult(row) });
    return true;
  }

  private writeFailure(item: Item, module: IntegrationModule, current: IntegrationResultRow | null, inputs: Record<string, unknown>, error: string): boolean {
    const attempts = (current?.attempts ?? 0) + 1;
    const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    // Keep the last good values, so the overlay survives a transient failure.
    return this.write(item, module, current, {
      ...(current ?? this.blank(item, module)),
      status: "error",
      error,
      inputs: canonical(inputs),
      attempts,
      next_attempt_at: attempts < MAX_ATTEMPTS ? this.now() + delay : null,
    });
  }

  private writeQuotaWait(item: Item, module: IntegrationModule, current: IntegrationResultRow | null, inputs: Record<string, unknown>, now: number): boolean {
    return this.write(item, module, current, {
      ...(current ?? this.blank(item, module)),
      status: "unprocessed",
      error: "quota",
      inputs: canonical(inputs),
      next_attempt_at: nextUtcMidnight(now),
    });
  }

  private writeConfigError(item: Item, module: IntegrationModule, current: IntegrationResultRow | undefined | null, error: string): boolean {
    return this.write(item, module, current ?? null, {
      ...(current ?? this.blank(item, module)),
      status: "error",
      error: `Config: ${error}`,
      inputs: null,
      next_attempt_at: null,
    });
  }

  private removeResult(row: IntegrationResult, item: Item): void {
    const syncKey = this.db.getItemSyncKey(item.id);
    if (!syncKey) return;
    const now = this.now();
    this.db.tombstoneIntegrationResult(row.id, syncKey, now);
    this.broadcast(syncKey, null, { type: "deleted", entity_type: "integration_result", entity_id: row.id, deleted_at: now });
  }

  // -- Lookups -------------------------------------------------------------

  private settings(module: IntegrationModule): IntegrationServerConfig {
    return { ...module.serverDefaults, ...this.serverConfig[module.id] };
  }

  private parseConfig(cfg: Integration): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
    if (!cfg.config) return { ok: true, value: {} };
    try {
      return { ok: true, value: parseToml(cfg.config) as Record<string, unknown> };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message.split("\n")[0] : String(err) };
    }
  }

  private itemContext(itemId: string): { item: Item; board: Board; syncKey: string; results: IntegrationResultRow[] } | null {
    const item = this.db.getEntityById("item", itemId) as Item | null;
    if (!item) return null;
    const list = this.db.getEntityById("list", item.list_id) as List | null;
    const board = list ? (this.db.getEntityById("board", list.board_id) as Board | null) : null;
    const syncKey = this.db.getItemSyncKey(itemId);
    if (!board || !syncKey) return null;
    return { item, board, syncKey, results: this.db.getIntegrationResultsForItem(itemId) };
  }
}
