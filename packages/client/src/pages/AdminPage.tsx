import { type Component, For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { db, type SyncConfig, type SyncEndpoint } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { syncStatus } from "../sync/syncStore.js";
import { endpointStatuses } from "../store/endpointStatuses.js";
import type { EndpointStatus } from "../store/endpointStatuses.js";
import { setSidebarOpen } from "../store/sidebarStore.js";

const PHASE_LABELS: Record<string, string> = {
  disabled: "Disabled",
  connecting: "Connecting…",
  handshaking: "Authenticating…",
  ready: "Connected",
  error: "Error",
  conflict: "ID Conflict",
};

const PHASE_COLORS: Record<string, string> = {
  disabled: "var(--text-dim)",
  connecting: "#f0a500",
  handshaking: "#f0a500",
  ready: "var(--success)",
  error: "var(--danger)",
  conflict: "var(--danger)",
};

function shortId(uuid: string | null | undefined): string {
  return uuid ? uuid.replace(/-/g, "").slice(0, 8) : "";
}

const AdminPage: Component = () => {
  const navigate = useNavigate();
  const [config, setConfig] = createSignal<SyncConfig | undefined>();
  const [endpoints, setEndpoints] = createSignal<SyncEndpoint[]>([]);
  const [syncKey, setSyncKey] = createSignal("");
  const [keyDirty, setKeyDirty] = createSignal(false);

  createEffect(() => {
    const sub = liveQuery(() => db.sync_config.get("default")).subscribe((cfg) => {
      setConfig(cfg);
      if (!keyDirty()) setSyncKey(cfg?.sync_key ?? "");
    });
    onCleanup(() => sub.unsubscribe());
  });

  createEffect(() => {
    const sub = liveQuery(() => db.sync_endpoints.orderBy("position").toArray()).subscribe((eps) => {
      setEndpoints(eps);
    });
    onCleanup(() => sub.unsubscribe());
  });

  const saveKey = async () => {
    const k = syncKey().trim();
    const existing = config();
    const clientId = existing?.client_id ?? crypto.randomUUID();
    if (existing) {
      await db.sync_config.update("default", { sync_key: k });
    } else {
      await db.sync_config.put({
        id: "default",
        sync_url: "",
        sync_key: k,
        client_id: clientId,
        enabled: true,
        last_sync_at: 0,
      });
    }
    setKeyDirty(false);
  };

  const addEndpoint = async () => {
    await db.sync_endpoints.add({
      id: crypto.randomUUID(),
      host: "",
      port: 443,
      enabled: true,
      secure: true,
      last_server_id: null,
      position: Date.now(),
    });
  };

  const deleteEndpoint = async (id: string) => {
    await db.sync_endpoints.delete(id);
  };

  const updateEndpoint = async (id: string, patch: Partial<SyncEndpoint>) => {
    await db.sync_endpoints.update(id, patch);
  };

  const statuses = endpointStatuses;
  const clientId = () => config()?.client_id ?? "";
  const connectedServerId = () => {
    for (const s of Object.values(statuses())) {
      if (s?.phase === "ready" && s.serverId) return shortId(s.serverId);
    }
    return null;
  };

  return (
    <div class="main admin-page">
      <div class="page-header">
        <button class="admin-back-btn" type="button" onClick={() => { setSidebarOpen(true); navigate(-1); }} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1>Administration</h1>
      </div>

      <div class="admin-content">
        <div class="admin-section">
          <h2>Sync credentials</h2>
          <div class="admin-field">
            <label class="field-label">Sync Key</label>
            <div class="admin-input-row">
              <input
                class="input"
                type="text"
                value={syncKey()}
                onInput={(e) => { setSyncKey(e.currentTarget.value); setKeyDirty(true); }}
                placeholder="shared secret — same on all devices"
              />
              <Show when={keyDirty()}>
                <button class="btn btn-primary" type="button" onClick={saveKey}>Save</button>
              </Show>
            </div>
            <div class="field-hint">All devices with the same sync key share data.</div>
          </div>
          <Show when={clientId()}>
            <div class="admin-field">
              <label class="field-label">Client ID</label>
              <div class="admin-client-id">{clientId()}</div>
              <div class="field-hint">Identifies this device. Assigned automatically.</div>
            </div>
          </Show>
          <div class="admin-input-row">
            <button class="btn" type="button" disabled={syncStatus() !== "connected"} onClick={() => syncClient.forceFullSync()}>
              Refresh from server
            </button>
            <Show when={connectedServerId()}>
              <span class="field-hint">server id {connectedServerId()}</span>
            </Show>
          </div>
        </div>

        <div class="admin-section">
          <div class="admin-section-title">
            <h2>Sync servers</h2>
            <button class="btn" type="button" onClick={addEndpoint}>+ Add</button>
          </div>
          <For each={endpoints()}>
            {(ep) => {
              const status = () => statuses()[ep.id] as EndpointStatus | undefined;
              const phase = () => status()?.phase ?? (ep.enabled ? "connecting" : "disabled");
              const wsUrl = () => `${ep.secure ? "wss" : "ws"}://${ep.host || "…"}:${ep.port}/sync`;
              const httpsUrl = () => `${ep.secure ? "https" : "http"}://${ep.host || "…"}:${ep.port}`;
              const connectedId = () => status()?.serverId ?? ep.last_server_id;
              return (
                <div class="endpoint-card" style={`border-color: ${PHASE_COLORS[phase()]}`}>
                  <div class="endpoint-header">
                    <input
                      type="checkbox"
                      checked={ep.enabled}
                      style={`accent-color: ${PHASE_COLORS[phase()]}`}
                      onChange={(e) => updateEndpoint(ep.id, { enabled: e.currentTarget.checked })}
                    />
                    <input
                      class="input endpoint-host"
                      type="text"
                      value={ep.host}
                      placeholder="hostname"
                      onBlur={(e) => updateEndpoint(ep.id, { host: e.currentTarget.value.trim() })}
                    />
                    <span class="endpoint-sep">:</span>
                    <input
                      class="input endpoint-port"
                      type="number"
                      value={ep.port}
                      placeholder="port"
                      onBlur={(e) => {
                        const n = parseInt(e.currentTarget.value);
                        updateEndpoint(ep.id, { port: isNaN(n) ? 443 : n });
                      }}
                    />
                    <label class="endpoint-tls-label">
                      <input
                        type="checkbox"
                        checked={ep.secure}
                        onChange={(e) => updateEndpoint(ep.id, { secure: e.currentTarget.checked })}
                      />
                      TLS
                    </label>
                    <button class="btn-icon-danger" type="button" onClick={() => deleteEndpoint(ep.id)}>✕</button>
                  </div>

                  <div class="endpoint-urls">
                    <span class="endpoint-url-chip"><span class="endpoint-url-proto">WS</span>{wsUrl()}</span>
                    <span class="endpoint-url-chip"><span class="endpoint-url-proto">HTTP</span>{httpsUrl()}</span>
                  </div>

                  <div class="endpoint-status-row">
                    <span class="sync-dot" style={`background: ${PHASE_COLORS[phase()] ?? "var(--text-dim)"}`} />
                    <span class="endpoint-phase-label">{PHASE_LABELS[phase()] ?? phase()}</span>
                    <Show when={status()?.message}>
                      <span class="endpoint-status-msg"> — {status()!.message}</span>
                    </Show>
                    <Show when={connectedId()}>
                      <span class="endpoint-server-id"> — server id {shortId(connectedId())}</span>
                    </Show>
                  </div>
                  <Show when={ep.secure && /^[\d.]+$|^[0-9a-f:]+$/i.test(ep.host)}>
                    <div class="endpoint-hint">TLS certificates are issued for hostnames, not IPs — try disabling TLS for this address.</div>
                  </Show>

                  <Show when={phase() === "conflict"}>
                    <div class="endpoint-conflict">
                      <div class="endpoint-conflict-msg">
                        Server ID changed from <code>{shortId(status()?.knownId)}</code> to <code>{shortId(status()?.newId)}</code>
                      </div>
                      <div class="endpoint-conflict-actions">
                        <button
                          class="btn btn-primary btn-sm"
                          type="button"
                          onClick={() => updateEndpoint(ep.id, { last_server_id: status()?.newId ?? null })}
                        >
                          Accept new server
                        </button>
                        <button
                          class="btn btn-sm"
                          type="button"
                          onClick={() => updateEndpoint(ep.id, { enabled: false })}
                        >
                          Disable
                        </button>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={endpoints().length === 0}>
            <div class="admin-empty">No sync servers configured. Click + Add to get started.</div>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default AdminPage;
