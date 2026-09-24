import { For, Show, createMemo, createSignal } from "solid-js";
import type { ConsoleClientRow, ConsoleClients } from "@listr/shared";
import { get } from "../api";
import { useLive } from "../components/live";
import { Loading, Stat, StateBadge } from "../components/ui";
import { ago, dateTime, short, span } from "../format";
import { href, navigate } from "../router";

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

export const clientRoute = (r: { client_id: string | null; conn_id: number | null; registered: boolean }) =>
  r.registered || !r.conn_id ? r.client_id ?? "" : `conn-${r.conn_id}`;

export function ClientsPage() {
  const { data, error } = useLive(() => get<ConsoleClients>("/clients"), { replaceOn: ["client.stats"] });
  const [connectedOnly, setConnectedOnly] = createSignal(false);
  const [stale, setStale] = createSignal(false);
  const [user, setUser] = createSignal("");
  const [state, setState] = createSignal("");

  const users = createMemo(() => {
    const m = new Map<string, string>();
    for (const r of data()?.rows ?? []) if (r.user_id) m.set(r.user_id, r.user_name ?? short(r.user_id));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  });

  const rows = () => (data()?.rows ?? []).filter((r: ConsoleClientRow) =>
    (!connectedOnly() || r.sockets > 0) &&
    (!stale() || (r.sockets === 0 && (r.last_seen === null || Date.now() - r.last_seen > STALE_MS))) &&
    (!user() || r.user_id === user()) &&
    (!state() || (state() === "unregistered" ? !r.registered : r.effective_state === state())));

  return (
    <section>
      <h1>Clients</h1>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(d) => (
          <>
            <div class="stats">
              <Stat label="Registered" value={d().counts.registered} />
              <Stat label="Connected now" value={d().counts.connected} tone={d().counts.connected ? "good" : undefined} />
              <Stat label="Not authenticated" value={d().counts.unauthenticated} sub="open sockets" tone={d().counts.unauthenticated ? "warn" : undefined} />
              <Stat label="Failed auths" value={d().counts.failed_auth_last_hour} sub="last hour" tone={d().counts.failed_auth_last_hour ? "bad" : undefined} />
            </div>
            <div class="filters">
              <label class="toggle"><input type="checkbox" checked={connectedOnly()} onChange={(e) => setConnectedOnly(e.currentTarget.checked)} /> Connected only</label>
              <label class="toggle"><input type="checkbox" checked={stale()} onChange={(e) => setStale(e.currentTarget.checked)} /> Not seen in 30 days</label>
              <label>User <select value={user()} onChange={(e) => setUser(e.currentTarget.value)}>
                <option value="">anyone</option>
                <For each={users()}>{([id, name]) => <option value={id}>{name}</option>}</For>
              </select></label>
              <label>State <select value={state()} onChange={(e) => setState(e.currentTarget.value)}>
                <option value="">any</option>
                <option value="active">active</option>
                <option value="suspended">suspended</option>
                <option value="revoked">revoked</option>
                <option value="unregistered">unregistered</option>
              </select></label>
            </div>
            <div class="table-scroll">
              <table class="table clickable">
                <thead>
                  <tr>
                    <th>Device</th><th>User</th><th>State</th><th>Connected</th><th>Last seen</th>
                    <th class="r">Protocol</th><th>IP</th><th>Origin</th><th class="r">Keys</th><th class="r">Msgs/min in / out</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={rows()} fallback={<tr><td colSpan={10} class="muted">No clients match.</td></tr>}>
                    {(r) => (
                      <tr tabindex="0" onClick={() => navigate("clients", clientRoute(r))}
                        onKeyDown={(e) => { if (e.key === "Enter") navigate("clients", clientRoute(r)); }}>
                        <td>
                          <span class={`dot ${r.sockets ? "on" : ""}`} aria-label={r.sockets ? "connected" : "offline"} />{" "}
                          <a href={href("clients", clientRoute(r))}>{r.registered ? r.label ?? "(unnamed device)" : "(unregistered)"}</a>{" "}
                          <span class="mono muted small">{short(r.client_id)}</span>
                        </td>
                        <td>
                          <Show when={r.user_id} fallback={<span class="muted">-</span>}>
                            <a href={href("trust", "users", r.user_id!)} onClick={(e) => e.stopPropagation()}>{r.user_name ?? short(r.user_id)}</a>
                          </Show>
                        </td>
                        <td>
                          <Show when={r.registered} fallback={<StateBadge state={r.conn_state} />}><StateBadge state={r.effective_state} /></Show>
                        </td>
                        <td>
                          <Show when={r.sockets} fallback={<span class="muted">-</span>}>
                            {r.sockets > 1 ? `${r.sockets} sockets, ` : ""}{span(Date.now() - (r.connected_since ?? Date.now()))}
                          </Show>
                        </td>
                        <td title={dateTime(r.last_seen)}>{r.sockets ? "now" : ago(r.last_seen)}</td>
                        <td class="r num">{r.protocol ?? "-"}</td>
                        <td class="mono">{r.ip ?? "-"}</td>
                        <td class="mono small">{r.origin ?? "-"}</td>
                        <td class="r num">{r.sockets ? r.keys : "-"}</td>
                        <td class="r num">{r.sockets ? `${r.msgs_in_per_min} / ${r.msgs_out_per_min}` : "-"}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </>
        )}
      </Show>
    </section>
  );
}
