import { For, Show } from "solid-js";
import type { ConsoleOverview } from "@listr/shared";
import { get } from "../api";
import { useLive } from "../components/live";
import { Badge, Loading, Stat } from "../components/ui";
import { ago, dateTime } from "../format";

export function OverviewPage() {
  const { data, error } = useLive(() => get<ConsoleOverview>("/overview"), {
    refetchOn: ["client.connect", "client.disconnect", "trust", "integration.stats"],
    throttleMs: 2000,
  });
  return (
    <section>
      <h1>Overview</h1>
      <Show when={data()} fallback={<Loading error={error()} />}>
        {(o) => (
          <>
            <p class="muted">
              <Badge tone={o().variant === "prod" ? "info" : "warn"}>{o().variant}</Badge>{" "}
              Up since {dateTime(o().started_at)} ({ago(o().started_at)})
            </p>
            <div class="stats">
              <Stat label="Users" value={o().users} href="#/trust" />
              <Stat label="Clients connected" value={o().clients_connected} sub={`${o().clients_registered} registered`} href="#/clients" />
              <Stat
                label="Cert days left"
                value={o().cert_days_left ?? "-"}
                tone={o().cert_days_left === null ? undefined : o().cert_days_left! < 7 ? "bad" : o().cert_days_left! < 14 ? "warn" : "good"}
                sub={o().cert_days_left === null ? "TLS off" : undefined}
                href="#/ports"
              />
            </div>
            <h2>Integrations</h2>
            <Show when={o().integrations.length} fallback={<p class="muted">No integrations configured.</p>}>
              <ul class="plain-list">
                <For each={o().integrations}>
                  {(i) => (
                    <li>
                      <a href="#/integrations">{i.name}</a>{" "}
                      <Badge tone={i.healthy ? "good" : "bad"}>{i.healthy ? "healthy" : "needs attention"}</Badge>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
