import { For, Show, createMemo, onCleanup } from "solid-js";
import type { ConsoleRequest, ConsoleRunDetail } from "@listr/shared";
import { get, onTopic } from "../api";
import { useLive } from "../components/live";
import { Badge, Json, KV, Loading, StateBadge } from "../components/ui";
import { bytes, dateTime, ms, pretty, prettyBody } from "../format";

function Headers(props: { headers: Record<string, string> | null }) {
  const entries = () => Object.entries(props.headers ?? {});
  return (
    <Show when={entries().length} fallback={<p class="muted small">None recorded.</p>}>
      <table class="table compact">
        <tbody>
          <For each={entries()}>{([k, v]) => <tr><th class="mono">{k}</th><td class="mono wrap">{v}</td></tr>}</For>
        </tbody>
      </table>
    </Show>
  );
}

function RequestRow(props: { req: ConsoleRequest; index: number; start: number; total: number }) {
  const r = () => props.req;
  const left = () => ((r().started_at - props.start) / props.total) * 100;
  const width = () => Math.max(0.5, ((r().duration_ms ?? 0) / props.total) * 100);
  const tone = () => (r().error ? "bad" : (r().status ?? 0) >= 400 ? "warn" : "good");
  return (
    <details class="request">
      <summary>
        <span class="req-method mono">{r().method}</span>
        <span class="req-url mono">{r().url}</span>
        <span class="req-status">
          <Show when={r().error} fallback={<Badge tone={tone()}>{r().status ?? "..."}</Badge>}><Badge tone="bad">failed</Badge></Show>
        </span>
        <span class="req-dur num">{ms(r().duration_ms)}</span>
        <span class="waterfall" aria-hidden="true">
          <span class={`waterfall-bar ${tone()}`} style={{ left: `${left()}%`, width: `${width()}%` }} />
        </span>
      </summary>
      <div class="request-body">
        <Show when={r().error}><p class="error-text">{r().error}</p></Show>
        <h4>Request headers</h4>
        <Headers headers={r().request_headers} />
        <h4>Response headers</h4>
        <Headers headers={r().response_headers} />
        <h4>Response body <span class="muted small">{bytes(r().body_bytes)}{r().body_truncated ? ", truncated to 64 KB" : ""}</span></h4>
        <Show when={r().body !== null} fallback={
          <p class="muted small">{r().body_dropped ? "Dropped to stay within the capture budget." : "Not captured."}</p>
        }>
          <pre class="body">{prettyBody(r().body!)}</pre>
        </Show>
      </div>
    </details>
  );
}

/** Top-level fields, and attribute values, that differ between two result rows. */
function diffRows(before: any, after: any): { field: string; before: string; after: string }[] {
  const rows: { field: string; before: string; after: string }[] = [];
  const fmt = (v: unknown) => (v === undefined ? "-" : typeof v === "string" ? v : JSON.stringify(v));
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    if (k === "attribute_values" || k === "updated_at") continue;
    const b = before?.[k], a = after?.[k];
    if (JSON.stringify(b) !== JSON.stringify(a)) rows.push({ field: k, before: fmt(b), after: fmt(a) });
  }
  const bv = before?.attribute_values ?? {}, av = after?.attribute_values ?? {};
  for (const k of new Set([...Object.keys(bv), ...Object.keys(av)])) {
    if (JSON.stringify(bv[k]) !== JSON.stringify(av[k])) rows.push({ field: `attribute_values.${k}`, before: fmt(bv[k]), after: fmt(av[k]) });
  }
  return rows;
}

export function RunPage(props: { id: number }) {
  const { data, error, refresh } = useLive(() => get<ConsoleRunDetail>(`/integrations/runs/${props.id}`));
  // A run is announced when it starts and again when it finishes.
  onCleanup(onTopic("integration.run", (r: { id: number }) => { if (r.id === props.id) void refresh(); }));
  const total = createMemo(() => {
    const d = data();
    if (!d) return 1;
    const end = Math.max(d.started_at + (d.duration_ms ?? 0), ...d.requests.map((r) => r.started_at + (r.duration_ms ?? 0)));
    return Math.max(1, end - d.started_at);
  });

  return (
    <section>
      <p><a href="#/integrations">Integrations</a> / run {props.id}</p>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(d) => (
          <>
            <h1>{d().module} run <StateBadge state={d().outcome} /></h1>
            <Show when={d().error}><p class="error-text">{d().error}</p></Show>
            <div class="two-col">
              <div class="card">
                <h2>Context</h2>
                <KV rows={[
                  ["Started", dateTime(d().started_at)],
                  ["Duration", ms(d().duration_ms)],
                  ["Item", <span class="mono">{d().item_id}</span>],
                  ["Board", <span class="mono">{d().board_id}</span>],
                  ["Sync key", <span class="mono">{d().key_tag}</span>],
                  ["Priority", d().priority],
                  ["Attempt", d().attempt],
                  ["Broadcast", d().broadcast ? "yes" : "no change"],
                ]} />
                <h3>Inputs</h3>
                <pre class="body">{pretty(d().inputs)}</pre>
              </div>
              <div class="card">
                <h2>Outcome</h2>
                <Show when={d().output} fallback={<p class="muted">{d().outcome === "running" ? "Still running." : "The module returned nothing."}</p>}>
                  {(o) => (
                    <>
                      <KV rows={[
                        ["Status", <StateBadge state={o().status} />],
                        ["Refresh at", o().refresh_at ? dateTime(o().refresh_at) : "never"],
                        ["Dropped keys", o().dropped.length ? <span class="mono">{o().dropped.join(", ")}</span> : "none"],
                      ]} />
                      <table class="table compact">
                        <thead><tr><th>Attribute</th><th>Returned</th><th>Stored</th></tr></thead>
                        <tbody>
                          <For each={Object.keys(o().raw_values)}>
                            {(k) => (
                              <tr classList={{ dropped: o().dropped.includes(k) }}>
                                <td class="mono">{k}</td>
                                <td class="mono wrap">{JSON.stringify(o().raw_values[k])}</td>
                                <td class="mono wrap">{k in o().attribute_values ? JSON.stringify(o().attribute_values[k]) : "dropped"}</td>
                              </tr>
                            )}
                          </For>
                        </tbody>
                      </table>
                      <Show when={o().choices}><Json value={o().choices} summary="Choices" /></Show>
                    </>
                  )}
                </Show>
              </div>
            </div>

            <h2>Requests</h2>
            <Show when={d().requests.length} fallback={<p class="muted">No HTTP requests.</p>}>
              <div class="card requests">
                <For each={d().requests}>{(r, i) => <RequestRow req={r} index={i()} start={d().started_at} total={total()} />}</For>
              </div>
            </Show>

            <h2>Stored result</h2>
            <Show when={diffRows(d().result_before, d().result_after).length} fallback={<p class="muted">Unchanged.</p>}>
              <table class="table">
                <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
                <tbody>
                  <For each={diffRows(d().result_before, d().result_after)}>
                    {(row) => <tr><td class="mono">{row.field}</td><td class="mono wrap">{row.before}</td><td class="mono wrap">{row.after}</td></tr>}
                  </For>
                </tbody>
              </table>
            </Show>
            <div class="two-col">
              <Json value={d().result_before} summary="Before (full row)" />
              <Json value={d().result_after} summary="After (full row)" />
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
