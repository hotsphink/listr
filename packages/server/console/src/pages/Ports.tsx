import { For, Show } from "solid-js";
import type { ConsoleCert, ConsolePorts } from "@listr/shared";
import { get } from "../api";
import { useLive } from "../components/live";
import { Badge, KV, Loading, Stat, type Tone } from "../components/ui";
import { ago, dateTime } from "../format";

function certTone(days: number): Tone {
  return days < 7 ? "bad" : days < 14 ? "warn" : "good";
}

function CertDetails(props: { cert: ConsoleCert }) {
  return (
    <KV rows={[
      ["Days left", <Badge tone={certTone(props.cert.days_left)}>{props.cert.days_left < 0 ? `expired ${-props.cert.days_left}d ago` : `${props.cert.days_left} days`}</Badge>],
      ["Valid to", dateTime(props.cert.valid_to)],
      ["Subject", props.cert.subject],
      ["Issuer", props.cert.issuer],
      ["Names", props.cert.sans.join(", ") || "-"],
    ]} />
  );
}

export function PortsPage() {
  // The stats event carries everything but the external probes, which the
  // server refreshes only when this endpoint is fetched.
  const { data, error } = useLive(() => get<ConsolePorts>("/ports"), { refetchOn: ["ports.stats"], throttleMs: 5000 });
  return (
    <section>
      <h1>Ports</h1>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(p) => (
          <>
            <p class="muted">
              Variant <Badge tone={p().variant === "prod" ? "info" : "warn"}>{p().variant}</Badge>, server id{" "}
              <span class="mono">{p().server_id}</span>, up {ago(p().started_at).replace(" ago", "")}
            </p>
            <h2>Listeners</h2>
            <table class="table">
              <thead><tr><th>Address</th><th>Port</th><th>Protocol</th><th>Serves</th></tr></thead>
              <tbody>
                <For each={p().listeners}>
                  {(l) => (
                    <tr>
                      <td class="mono">{l.address}</td>
                      <td class="num">{l.port}</td>
                      <td><Badge tone={l.protocol === "https" ? "good" : "warn"}>{l.protocol}</Badge></td>
                      <td>{l.routes.join(", ")}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>

            <div class="stats">
              <Stat label="Open WebSockets" value={p().websockets_open} href="#/clients" />
              <Stat label="Rejected: origin" value={p().rejected_upgrades.origin ?? 0} tone={(p().rejected_upgrades.origin ?? 0) ? "warn" : undefined} sub="since start" />
              <Stat label="Rejected: per-IP limit" value={p().rejected_upgrades.per_ip ?? 0} tone={(p().rejected_upgrades.per_ip ?? 0) ? "warn" : undefined} sub="since start" />
              <Stat label="Rate-limit closes" value={p().rate_limit_closes} tone={p().rate_limit_closes ? "bad" : undefined} sub="since start" />
            </div>

            <div class="two-col">
              <div class="card">
                <h2>Certificate</h2>
                <Show when={p().cert} fallback={
                  <p class={p().cert_error ? "error-text" : "muted"}>{p().cert_error ?? "TLS is off on this listener."}</p>
                }>
                  {(c) => (
                    <>
                      <CertDetails cert={c()} />
                      <Show when={c().days_left < 14}>
                        <p class="warn-text">Fix: <span class="mono">pnpm certs:refresh</span>, then restart this server.</p>
                      </Show>
                    </>
                  )}
                </Show>
              </div>
              <div class="card">
                <h2>Connections per IP</h2>
                <Show when={p().per_ip.length} fallback={<p class="muted">None open.</p>}>
                  <table class="table compact">
                    <thead><tr><th>IP</th><th class="r">Sockets</th></tr></thead>
                    <tbody><For each={p().per_ip}>{(r) => <tr><td class="mono">{r.ip}</td><td class="r num">{r.count}</td></tr>}</For></tbody>
                  </table>
                  <p class="muted small">Behind Funnel or a proxy, this is the proxy's address.</p>
                </Show>
              </div>
            </div>

            <h2>External URLs</h2>
            <Show when={p().external.length} fallback={
              <p class="muted">None configured. List public URLs that forward here under <span class="mono">console.external_urls</span> to probe them.</p>
            }>
              <table class="table">
                <thead><tr><th>URL</th><th>Reachable</th><th>Cert</th><th>Checked</th></tr></thead>
                <tbody>
                  <For each={p().external}>
                    {(e) => (
                      <tr>
                        <td class="mono">{e.url}</td>
                        <td>
                          <Badge tone={e.ok ? "good" : "bad"}>{e.ok ? "ok" : "failed"}</Badge>{" "}
                          <Show when={e.error}><span class="muted small">{e.error}</span></Show>
                        </td>
                        <td>
                          <Show when={e.cert} fallback={<span class="muted">-</span>}>
                            {(c) => <Badge tone={certTone(c().days_left)} title={`${c().subject}, valid to ${dateTime(c().valid_to)}`}>{c().days_left}d left</Badge>}
                          </Show>
                        </td>
                        <td>{ago(e.checked_at)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <h2>Allowed origins</h2>
            <ul class="inline-list mono">
              <For each={p().allowed_origins}>{(o) => <li>{o}</li>}</For>
            </ul>
          </>
        )}
      </Show>
    </section>
  );
}
