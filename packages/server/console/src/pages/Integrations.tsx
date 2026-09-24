import { For, Index, Show, createSignal, onCleanup } from "solid-js";
import type { ConsoleImportStats, ConsoleIntegrationModule, ConsoleIntegrations, ConsoleRunSummary } from "@listr/shared";
import { get, onTopic } from "../api";
import { useLive } from "../components/live";
import { Badge, Loading, Meter, Sparkline, StateBadge } from "../components/ui";
import { ago, dateTime, ms, time } from "../format";
import { href, navigate } from "../router";

const STATUSES = ["complete", "not_found", "ambiguous", "error", "unprocessed"];

function ModuleCard(props: { m: ConsoleIntegrationModule }) {
  const m = () => props.m;
  const bad = () => m().errors_last_5m > 0 || m().quota_resets_at !== null;
  return (
    <article class="card module-card" classList={{ alert: bad() }} aria-label={`${m().name} integration`}>
      <header class="card-head">
        <h3>{m().name}</h3>
        <Show when={m().active} fallback={<Badge tone="bad">inactive</Badge>}><Badge tone="good">active</Badge></Show>
        <Show when={m().quota_resets_at}>
          {(at) => <Badge tone="warn" title={dateTime(at())}>quota: resets {ago(at())}</Badge>}
        </Show>
      </header>
      <div class="module-grid">
        <div>
          <div class="mini-label">Queue</div>
          <div class="num big">{m().queued_edit + m().queued_refresh}</div>
          <div class="muted small">{m().queued_edit} edit, {m().queued_refresh} refresh</div>
        </div>
        <div>
          <div class="mini-label">Running</div>
          <div class="num big">{m().running}<span class="muted small"> / {m().max_concurrent}</span></div>
        </div>
        <div>
          <div class="mini-label">Latency p50 / p95</div>
          <div class="num">{ms(m().latency_p50_ms)} / {ms(m().latency_p95_ms)}</div>
          <div class="muted small">last 15 minutes</div>
        </div>
      </div>
      <Meter used={m().calls_today} limit={m().daily_limit}
        label={m().counts_since_restart ? "External calls since restart" : "External calls today (UTC)"} />
      <Show when={m().counts_since_restart}>
        <p class="muted small">Counts reset when the server restarted, so they cover less than the whole day.</p>
      </Show>
      <Show when={m().top_keys.length}>
        <div class="mini-label">Busiest keys{m().daily_limit_per_key !== null ? ` (limit ${m().daily_limit_per_key} each)` : ""}</div>
        <ul class="inline-list">
          <For each={m().top_keys}>
            {(k) => (
              <li>
                <span class="mono">{k.key_tag}</span>{" "}
                <Show when={m().daily_limit_per_key !== null && k.count >= m().daily_limit_per_key!} fallback={<span class="num">{k.count}</span>}>
                  <Badge tone="warn" title="This key has used its daily budget">{k.count}, at limit</Badge>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="sparks">
        <Sparkline series={m().calls_per_minute} label="calls" />
        <Sparkline series={m().errors_per_minute} label="errors" tone="bad" />
      </div>
      <div class="mini-label">Stored results</div>
      <ul class="inline-list">
        <For each={STATUSES}>
          {(s) => <li><StateBadge state={s} /> <span class="num">{m().results.by_status[s] ?? 0}</span></li>}
        </For>
      </ul>
      <p class="muted small">
        {m().results.quota_waits} waiting on quota, {m().results.retries_pending} retries pending,{" "}
        {m().results.refreshes_due} refreshes due within the hour
      </p>
    </article>
  );
}

function ImportCard(props: { s: ConsoleImportStats }) {
  const s = () => props.s;
  return (
    <article class="card module-card" aria-label="Screenshot import">
      <header class="card-head">
        <h3>Screenshot import</h3>
        <Show when={s().configured} fallback={<Badge tone="muted">not configured</Badge>}><Badge tone="good">configured</Badge></Show>
      </header>
      <Show when={s().configured}>
        <p class="muted small">Tiers: {s().tiers.map((t) => t.join(" + ")).join(" then ")}</p>
      </Show>
      <div class="module-grid">
        <div><div class="mini-label">Calls</div><div class="num big">{s().calls}</div><div class="muted small">since restart</div></div>
        <div><div class="mini-label">OK / failed</div><div class="num big">{s().ok}<span class="muted small"> / {s().failed}</span></div></div>
        <div><div class="mini-label">Latency p50 / p95</div><div class="num">{ms(s().latency_p50_ms)} / {ms(s().latency_p95_ms)}</div></div>
      </div>
      <Sparkline series={s().calls_per_minute} label="imports" />
      <Show when={s().last_error}>
        <p class="error-text small">Last error: {s().last_error}</p>
      </Show>
      <Show when={s().last_at}><p class="muted small">Last import {ago(s().last_at)}</p></Show>
    </article>
  );
}

function RecentRuns(props: { modules: string[] }) {
  const [module, setModule] = createSignal("");
  const [outcome, setOutcome] = createSignal("");
  const [key, setKey] = createSignal("");
  const [item, setItem] = createSignal("");
  const [runs, setRuns] = createSignal<ConsoleRunSummary[]>([]);
  const [queued, setQueued] = createSignal<ConsoleRunSummary[]>([]);
  const [paused, setPaused] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const matches = (r: ConsoleRunSummary) =>
    (!module() || r.module === module()) && (!outcome() || r.outcome === outcome()) &&
    (!key() || r.key_tag.startsWith(key().slice(0, 6))) && (!item() || r.item_id.startsWith(item()));

  const load = async () => {
    const q = new URLSearchParams({ limit: "100" });
    if (module()) q.set("module", module());
    if (outcome()) q.set("outcome", outcome());
    if (key()) q.set("key", key());
    if (item()) q.set("item", item());
    try {
      setRuns(await get<ConsoleRunSummary[]>(`/integrations/runs?${q}`));
      setQueued([]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  void load();

  // Upsert by id: a run arrives once when it starts and again when it ends.
  const upsert = (list: ConsoleRunSummary[], r: ConsoleRunSummary) => {
    const i = list.findIndex((x) => x.id === r.id);
    if (i >= 0) return list.map((x) => (x.id === r.id ? r : x));
    return [r, ...list].slice(0, 200);
  };
  onCleanup(onTopic("integration.run", (r: ConsoleRunSummary) => {
    if (!matches(r)) return;
    if (paused() && !runs().some((x) => x.id === r.id)) setQueued((q) => upsert(q, r));
    else setRuns((list) => upsert(list, r));
  }));
  const resume = () => {
    let list = runs();
    for (const r of [...queued()].reverse()) list = upsert(list, r);
    setRuns(list);
    setQueued([]);
    setPaused(false);
  };

  const input = (label: string, value: () => string, set: (v: string) => void, placeholder: string) => (
    <label>{label} <input type="search" value={value()} placeholder={placeholder}
      onChange={(e) => { set(e.currentTarget.value.trim()); void load(); }} /></label>
  );

  return (
    <section>
      <h2>Recent runs</h2>
      <div class="filters">
        <label>Module <select value={module()} onChange={(e) => { setModule(e.currentTarget.value); void load(); }}>
          <option value="">all</option>
          <For each={props.modules}>{(m) => <option value={m}>{m}</option>}</For>
        </select></label>
        <label>Outcome <select value={outcome()} onChange={(e) => { setOutcome(e.currentTarget.value); void load(); }}>
          <option value="">all</option>
          <For each={["running", "complete", "not_found", "ambiguous", "error", "quota", "stale", "config_error"]}>{(o) => <option value={o}>{o}</option>}</For>
        </select></label>
        {input("Key", key, setKey, "tag")}
        {input("Item", item, setItem, "item id")}
        <Show when={queued().length}>
          <button type="button" class="pill" onClick={resume}>{queued().length} new</button>
        </Show>
      </div>
      <Show when={!error()} fallback={<Loading error={error()} />}>
        <div class="table-scroll" onMouseEnter={() => setPaused(true)} onMouseLeave={resume}
          onScroll={(e) => { if (e.currentTarget.scrollTop > 0) setPaused(true); }}>
          <table class="table clickable">
            <thead>
              <tr><th>Time</th><th>Module</th><th>Item</th><th>Key</th><th>Priority</th><th class="r">Requests</th><th class="r">Duration</th><th>Outcome</th></tr>
            </thead>
            <tbody>
              <For each={runs()} fallback={<tr><td colSpan={8} class="muted">No runs since the server started.</td></tr>}>
                {(r) => (
                  <tr tabindex="0" onClick={() => navigate("integrations", "runs", r.id)}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate("integrations", "runs", r.id); }}>
                    <td title={dateTime(r.started_at)}><a href={href("integrations", "runs", r.id)}>{time(r.started_at)}</a></td>
                    <td>{r.module}</td>
                    <td class="mono">{r.item_id.slice(0, 10)}</td>
                    <td class="mono">{r.key_tag}</td>
                    <td>{r.priority}</td>
                    <td class="r num">{r.request_count}</td>
                    <td class="r num">{ms(r.duration_ms)}</td>
                    <td><StateBadge state={r.outcome} /> <Show when={r.error}><span class="muted small" title={r.error!}>{r.error!.slice(0, 40)}</span></Show></td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  );
}

export function IntegrationsPage() {
  const { data, error } = useLive(() => get<ConsoleIntegrations>("/integrations"), { replaceOn: ["integration.stats"] });
  return (
    <section>
      <h1>Integrations</h1>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(d) => (
          <>
            <div class="card-grid">
              <Show when={d().modules.length} fallback={<p class="muted">No integrations configured on this server.</p>}>
                <Index each={d().modules}>{(m) => <ModuleCard m={m()} />}</Index>
              </Show>
              <ImportCard s={d().import} />
            </div>
            <RecentRuns modules={d().modules.map((m) => m.id)} />
          </>
        )}
      </Show>
    </section>
  );
}
