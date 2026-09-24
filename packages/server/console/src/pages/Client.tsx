import { For, Show } from "solid-js";
import type { ConsoleClientDetail, ConsoleSeries } from "@listr/shared";
import { get } from "../api";
import { useLive } from "../components/live";
import { Json, KV, Loading, Sparkline, StateBadge } from "../components/ui";
import { ago, bytes, dateTime, short, span, sum, time } from "../format";
import { href } from "../router";

function CountTable(props: { title: string; counts: Record<string, number> }) {
  const entries = () => Object.entries(props.counts).sort((a, b) => b[1] - a[1]);
  return (
    <div>
      <h3>{props.title} <span class="muted small num">{sum(props.counts)}</span></h3>
      <Show when={entries().length} fallback={<p class="muted small">None.</p>}>
        <table class="table compact">
          <tbody><For each={entries()}>{([k, v]) => <tr><td class="mono">{k}</td><td class="r num">{v}</td></tr>}</For></tbody>
        </table>
      </Show>
    </div>
  );
}

// Token samples are irregular, so spread them evenly for the sparkline.
function tokenSeries(tokens: { at: number; level: number }[]): ConsoleSeries {
  return { start: tokens[0]?.at ?? 0, bucket_ms: 1000, values: tokens.map((t) => t.level) };
}

export function ClientPage(props: { id: string }) {
  const { data, error } = useLive(() => get<ConsoleClientDetail>(`/clients/${encodeURIComponent(props.id)}`), {
    refetchOn: ["client.stats"],
    throttleMs: 2000,
  });
  return (
    <section>
      <p><a href="#/clients">Clients</a> / {short(props.id, 12)}</p>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(d) => {
          const current = () => d().connections[0];
          return (
            <>
              <h1>
                {d().client ? d().client!.label ?? "(unnamed device)" : "Unregistered socket"}{" "}
                <Show when={current()}><StateBadge state={current()!.state} /></Show>
              </h1>
              <div class="two-col">
                <div class="card">
                  <h2>Identity</h2>
                  <Show when={d().client} fallback={
                    <KV rows={[
                      ["Client id", <span class="mono">{d().client_id ?? "(no hello yet)"}</span>],
                      ["Registered", "no"],
                    ]} />
                  }>
                    {(c) => (
                      <>
                        <KV rows={[
                          ["Client id", <span class="mono wrap">{c().client_id}</span>],
                          ["User", <a href={href("trust", "users", c().user_id)}>{c().user_name ?? short(c().user_id)}</a>],
                          ["User state", <StateBadge state={c().effective_state} />],
                          ["Registered", dateTime(c().created_at)],
                          ["Last seen", `${dateTime(c().last_seen)} (${ago(c().last_seen)})`],
                          ["Joined via grant", c().registered_by_grant ? <span class="mono">{short(c().registered_by_grant)}</span> : "unknown"],
                        ]} />
                        <Json value={c().pubkey_jwk} summary="Public key (JWK)" />
                      </>
                    )}
                  </Show>
                </div>
                <div class="card">
                  <h2>Keys</h2>
                  <Show when={d().keys.length} fallback={<p class="muted">No keys on the current connection.</p>}>
                    <table class="table compact">
                      <thead><tr><th>Key</th><th>Name</th><th>Last pulled since</th></tr></thead>
                      <tbody>
                        <For each={d().keys}>
                          {(k) => <tr><td class="mono">{k.tag}</td><td>{k.name ?? "-"}</td><td>{k.since === null ? "-" : k.since === 0 ? "full pull" : dateTime(k.since)}</td></tr>}
                        </For>
                      </tbody>
                    </table>
                  </Show>
                  <h3>Rate-limit bucket</h3>
                  <Show when={d().tokens.length > 1} fallback={<p class="muted small">Not enough samples yet.</p>}>
                    <Sparkline series={tokenSeries(d().tokens)} label={`tokens of ${d().token_burst}`} />
                    <p class="muted small">Now {d().tokens[d().tokens.length - 1].level} of {d().token_burst}. The connection closes at 0.</p>
                  </Show>
                </div>
              </div>

              <h2>Connections</h2>
              <table class="table">
                <thead><tr><th>#</th><th>State</th><th>Opened</th><th>Duration</th><th>IP</th><th>Origin</th><th>Protocol</th><th>Close</th></tr></thead>
                <tbody>
                  <For each={d().connections} fallback={<tr><td colSpan={8} class="muted">None since the server started.</td></tr>}>
                    {(c) => (
                      <tr classList={{ "row-bad": c.close_code !== null && c.close_code !== 1000 && c.close_code !== 1001 && c.close_code !== 1005 }}>
                        <td class="num">{c.id}</td>
                        <td><StateBadge state={c.state} /></td>
                        <td title={dateTime(c.opened_at)}>{ago(c.opened_at)}</td>
                        <td>{span((c.closed_at ?? Date.now()) - c.opened_at)}</td>
                        <td class="mono">{c.ip}</td>
                        <td class="mono small">{c.origin ?? "-"}</td>
                        <td class="num">{c.protocol ?? "-"}</td>
                        <td>{c.close_code === null ? "-" : `${c.close_code}${c.close_reason ? ` ${c.close_reason}` : ""}`}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
              <Show when={current()?.user_agent}><p class="muted small">User agent: {current()!.user_agent}</p></Show>

              <h2>Traffic <span class="muted small">current connection, {bytes(d().traffic.bytes_in)} in, {bytes(d().traffic.bytes_out)} out</span></h2>
              <div class="three-col">
                <CountTable title="Messages in" counts={d().traffic.in} />
                <CountTable title="Messages out" counts={d().traffic.out} />
                <CountTable title="Pushes by type" counts={d().traffic.pushes} />
              </div>

              <h3>Pulls</h3>
              <Show when={d().pulls.length} fallback={<p class="muted small">None.</p>}>
                <table class="table compact">
                  <thead><tr><th>When</th><th class="r">Keys</th><th>Returned</th></tr></thead>
                  <tbody>
                    <For each={[...d().pulls].reverse()}>
                      {(p) => (
                        <tr>
                          <td title={dateTime(p.at)}>{time(p.at)}</td>
                          <td class="r num">{p.keys}</td>
                          <td class="small">{Object.entries(p.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", ") || "nothing new"}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>

              <h2>Errors</h2>
              <Show when={d().errors.length} fallback={<p class="muted">None.</p>}>
                <table class="table compact">
                  <thead><tr><th>When</th><th>Reason</th><th>Message</th></tr></thead>
                  <tbody>
                    <For each={d().errors}>
                      {(e) => <tr><td title={dateTime(e.at)}>{ago(e.at)}</td><td class="mono">{e.reason ?? "-"}</td><td>{e.message}</td></tr>}
                    </For>
                  </tbody>
                </table>
              </Show>

              <h2>Message log <span class="muted small">newest first, metadata only</span></h2>
              <div class="table-scroll tall">
                <table class="table compact">
                  <thead><tr><th>Time</th><th>Dir</th><th>Type</th><th class="r">Size</th><th>Detail</th></tr></thead>
                  <tbody>
                    <For each={d().log} fallback={<tr><td colSpan={5} class="muted">No messages.</td></tr>}>
                      {(m) => (
                        <tr>
                          <td>{time(m.at)}</td>
                          <td><span class={`dir ${m.dir}`}>{m.dir === "in" ? "in" : "out"}</span></td>
                          <td class="mono">{m.type}</td>
                          <td class="r num">{bytes(m.bytes)}</td>
                          <td class="mono small">{m.detail ?? ""}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Show>
    </section>
  );
}
