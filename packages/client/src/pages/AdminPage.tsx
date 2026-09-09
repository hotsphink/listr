import { type Component, For, Show, createSignal, createEffect, onCleanup } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { liveQuery } from "dexie";
import { db, type ServerIdentity, type SyncEndpoint } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { PROTOCOL_VERSION } from "../sync/protocol.js";
import { syncStatus } from "../sync/syncStore.js";
import { endpointStatuses } from "../store/endpointStatuses.js";
import type { EndpointStatus } from "../store/endpointStatuses.js";
import { setSidebarOpen } from "../store/sidebarStore.js";
import { exportAllData } from "../db/exportImport.js";
import { triggerDownload } from "../utils/download.js";
import ImportModal from "../components/ImportModal.js";
import GrantModal from "../components/GrantModal.js";
import RedeemGrantModal from "../components/RedeemGrantModal.js";

const PHASE_LABELS: Record<string, string> = {
  disabled: "Disabled",
  connecting: "Connecting…",
  handshaking: "Authenticating…",
  needs_grant: "Not registered",
  ready: "Connected",
  error: "Error",
  conflict: "ID Conflict",
  variant_mismatch: "Wrong Server",
};

const PHASE_STATUS_CLASSES: Record<string, string> = {
  disabled: "",
  connecting: "status-warning",
  handshaking: "status-warning",
  needs_grant: "status-warning",
  ready: "status-success",
  error: "status-danger",
  conflict: "status-danger",
  variant_mismatch: "status-danger",
};

// The status class an endpoint card wears. Everything inside it that reports
// the connection — the border, the dot, the enable checkbox — colours itself
// from the card's --status. "is-standby" marks a connection that is ready but
// lost the race for its server_id to another endpoint (see
// SyncClient.claimOrDefer): connected, but standing by rather than actively
// pushing and pulling.
function statusClass(status: EndpointStatus | undefined, phase: string): string {
  if (phase === "ready" && status?.primary === false) return "status-warning is-standby";
  return PHASE_STATUS_CLASSES[phase] ?? "";
}

function statusLabel(status: EndpointStatus | undefined, phase: string): string {
  if (phase === "ready" && status?.primary === false) return "Standby (same server)";
  return PHASE_LABELS[phase] ?? phase;
}

function shortId(uuid: string | null | undefined): string {
  return uuid ? uuid.replace(/-/g, "").slice(0, 8) : "";
}

// Injected by Vite (see vite.config.ts). Format for display, falling back to
// the raw value if it isn't a parseable date.
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

const ForceUpdateButton: Component = () => {
  const [state, setState] = createSignal<"idle" | "working" | "error">("idle");
  const [online, setOnline] = createSignal(navigator.onLine);

  const onOnline = () => setOnline(true);
  const onOffline = () => setOnline(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  onCleanup(() => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  });

  const handleClick = async () => {
    if (!navigator.onLine) return;
    setState("working");
    try {
      // Probe the server before wiping the cache. If it is unreachable, bail
      // without clearing anything, so the app stays functional.
      await fetch(location.href, { method: "HEAD", cache: "no-store" });
      // Clear all SW caches so the next load fetches fresh assets.
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      // Nudge any waiting SW to activate immediately.
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) {
        await reg.update();
        reg.waiting?.postMessage({ type: "SKIP_WAITING" });
      }
      window.location.reload();
    } catch (e) {
      console.error("Force update failed:", e);
      setState("error");
    }
  };

  return (
    <div>
      <button class="btn-primary" disabled={!online() || state() === "working"} onClick={handleClick}>
        {state() === "working" ? "Updating…" : "Update Now"}
      </button>
      <Show when={!online()}>
        <div class="field-hint">Unavailable offline.</div>
      </Show>
      <Show when={state() === "error"}>
        <div class="field-error">Update failed — check the console.</div>
      </Show>
    </div>
  );
};

const AdminPage: Component = () => {
  const navigate = useNavigate();
  const [endpoints, setEndpoints] = createSignal<SyncEndpoint[]>([]);
  const [identities, setIdentities] = createSignal<ServerIdentity[]>([]);
  const [showImport, setShowImport] = createSignal(false);
  const [showBackupHelp, setShowBackupHelp] = createSignal(false);
  const [showGrantModal, setShowGrantModal] = createSignal(false);
  const [joiningEndpointId, setJoiningEndpointId] = createSignal<string | null>(null);
  const [devices, setDevices] = createSignal<{ client_id: string; label: string | null; last_seen: number | null }[]>([]);
  const [displayNameInput, setDisplayNameInput] = createSignal("");
  const [displayNameDirty, setDisplayNameDirty] = createSignal(false);
  const [displayNameError, setDisplayNameError] = createSignal<string | null>(null);
  const [renamingClientId, setRenamingClientId] = createSignal<string | null>(null);
  const [renameInput, setRenameInput] = createSignal("");
  const [deviceError, setDeviceError] = createSignal<string | null>(null);

  createEffect(() => {
    const sub = liveQuery(() => db.sync_endpoints.orderBy("position").toArray()).subscribe((eps) => {
      setEndpoints(eps);
    });
    onCleanup(() => sub.unsubscribe());
  });

  // Per-server registration state. Identity comes from the server, via the
  // `ok` message's fields, and never from anything typed into this page.
  createEffect(() => {
    const sub = liveQuery(() => db.server_identity.toArray()).subscribe(setIdentities);
    onCleanup(() => sub.unsubscribe());
  });

  // The endpoint id currently reaching whichever server the active identity
  // is on. Identity is keyed by server_id, while the wire calls
  // (createGrant, listClients, setDisplayName) are made against a connection,
  // which is keyed by endpoint id. This picks the first ready endpoint on that
  // server, the same "pick one" convention SyncClient.getPrimaryServerId uses
  // for the multi-server case.
  const primaryIdentity = () => identities().find((i) => i.state === "active") ?? null;

  // Only a connection that can be sent on right now qualifies, not merely one
  // associated with this server. Neither `sync_endpoints.last_server_id` nor
  // `EndpointStatus.serverId` is sufficient on its own, since both survive a
  // dropped socket: last_server_id is persisted, and an EndpointStatus keeps
  // the serverId from its last handshake even once the phase has gone to
  // "error", because the close handler sets only phase and message. Either
  // could hand back a dead endpoint, and every wire call here
  // (setDisplayName, listClients, createGrant) throws "no open connection" on
  // one. Requiring phase === "ready" is what makes this accurate, and it stays
  // reactive because `statuses()` updates on connect and close.
  const primaryEndpointId = (): string | null => {
    const serverId = primaryIdentity()?.server_id;
    if (!serverId) return null;
    for (const ep of endpoints()) {
      const status = statuses()[ep.id] as EndpointStatus | undefined;
      if (status?.phase === "ready" && status.serverId === serverId) return ep.id;
    }
    return null;
  };

  const needsGrantEndpoints = () =>
    endpoints().filter((ep) => ((statuses()[ep.id] as EndpointStatus | undefined)?.phase ?? (ep.enabled ? "connecting" : "disabled")) === "needs_grant");

  createEffect(() => {
    if (!displayNameDirty()) setDisplayNameInput(primaryIdentity()?.display_name ?? "");
  });

  // "ready" can still go stale between the check and the send, and an
  // exception thrown out of a createEffect stops that effect re-running for
  // the rest of the page's life, so a transient reconnect could otherwise
  // permanently kill the device list.
  const requestDevices = (epId: string) => {
    try {
      syncClient.listClients(epId);
    } catch (err) {
      console.warn("listClients skipped:", err);
    }
  };

  const refreshDevices = () => {
    const epId = primaryEndpointId();
    if (epId) requestDevices(epId);
  };

  // The server answers set_client_label with the refreshed `clients` list, so
  // the onGrantReply handler updates the list. There is nothing to do here
  // beyond closing the editor.
  const saveClientLabel = (targetClientId: string) => {
    setDeviceError(null);
    const epId = primaryEndpointId();
    if (!epId) {
      setDeviceError("Not connected to a server right now — try again once sync is connected.");
      return;
    }
    try {
      syncClient.setClientLabel(epId, targetClientId, renameInput().trim() || null);
      setRenamingClientId(null);
    } catch (err) {
      setDeviceError(err instanceof Error ? err.message : String(err));
    }
  };

  createEffect(() => {
    const epId = primaryEndpointId();
    if (!epId) return;
    const unsubscribe = syncClient.onGrantReply(epId, (msg) => {
      if (msg.type === "clients") { setDevices(msg.clients ?? []); setDeviceError(null); }
      else if (msg.type === "error" && msg.reason === "bad_request") setDeviceError(msg.message ?? "That device couldn't be renamed.");
      else if (msg.type === "display_name_set") {
        setDisplayNameDirty(false);
        setDisplayNameError(null);
      }
    });
    onCleanup(unsubscribe);
    requestDevices(epId);
  });

  // Both failure modes here used to be silent, which is exactly what makes a
  // stuck Save button so confusing: the flag that hides the button is only
  // cleared by the server's `display_name_set` reply, so anything that stops
  // the request going out leaves the button sitting there with no explanation.
  const saveDisplayName = () => {
    setDisplayNameError(null);
    const epId = primaryEndpointId();
    if (!epId) {
      setDisplayNameError("Not connected to a server right now — try again once sync is connected.");
      return;
    }
    try {
      syncClient.setDisplayName(epId, displayNameInput().trim() || null);
    } catch (err) {
      // setDisplayName throws when that endpoint has no open socket (e.g. the
      // identity resolved to an endpoint that has since dropped).
      setDisplayNameError(err instanceof Error ? err.message : String(err));
    }
  };

  const addEndpoint = async () => {
    const id = crypto.randomUUID();
    await db.sync_endpoints.add({
      id,
      host: "",
      port: 443,
      enabled: true,
      secure: true,
      last_server_id: null,
      position: Date.now(),
    });
    setExpandedIds((prev) => { prev.add(id); return prev; });
  };

  const deleteEndpoint = async (id: string) => {
    await db.sync_endpoints.delete(id);
  };

  const updateEndpoint = async (id: string, patch: Partial<SyncEndpoint>) => {
    await db.sync_endpoints.update(id, patch);
  };

  const [expandedIds, setExpandedIds] = createSignal(new Set<string>(), { equals: false });
  const autoExpanded = new Set<string>();

  // Auto-expand the first endpoint that becomes "ready" (connected).
  // Tracks what's been auto-expanded so user collapses aren't overridden.
  createEffect(() => {
    for (const ep of endpoints()) {
      const ph = (statuses()[ep.id] as EndpointStatus | undefined)?.phase;
      if ((ph === "ready" || ph === "variant_mismatch") && !autoExpanded.has(ep.id)) {
        autoExpanded.add(ep.id);
        setExpandedIds((prev) => { prev.add(ep.id); return prev; });
      }
    }
  });

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => { prev.has(id) ? prev.delete(id) : prev.add(id); return prev; });
  };

  const statuses = endpointStatuses;
  const [clientId, setClientId] = createSignal("");
  createEffect(() => {
    const sub = liveQuery(() => db.client_identity.get("default")).subscribe((identity) => {
      setClientId(identity?.client_id ?? "");
    });
    onCleanup(() => sub.unsubscribe());
  });
  const connectedServerId = () => {
    for (const s of Object.values(statuses())) {
      if (s?.phase === "ready" && s.serverId) return shortId(s.serverId);
    }
    return null;
  };

  return (
    <div class="main admin-page">
      <div class="page-header">
        <button class="btn-icon btn-icon-lg btn-icon-strong" type="button" onClick={() => { setSidebarOpen(true); navigate(-1); }} aria-label="Back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
        </button>
        <h1>Administration</h1>
      </div>

      <div class="admin-content">
        <div class="admin-section">
          <h2>Identity</h2>
          <Show
            when={primaryIdentity()}
            fallback={<div class="empty-note">Not registered with any server yet.</div>}
          >
            {(identity) => (
              <>
                {/* One box: the nickname IS the identity as far as a person is
                    concerned, so it leads. The user id and caps are machine
                    facts you occasionally need to read out, not things to lead
                    with, so they sit underneath as hints. */}
                <div class="form-field">
                  <label class="field-label" for="admin-display-name">You are</label>
                  <div class="control-row">
                    <input
                      id="admin-display-name"
                      type="text"
                      value={displayNameInput()}
                      onInput={(e) => { setDisplayNameInput(e.currentTarget.value); setDisplayNameDirty(true); }}
                      placeholder="a nickname — not your real name if you'd rather not"
                    />
                    <Show when={displayNameDirty()}>
                      <button class="btn-primary" type="button" onClick={saveDisplayName}>Save</button>
                    </Show>
                  </div>
                  <Show when={displayNameError()}>
                    <div class="field-error" role="alert">{displayNameError()}</div>
                  </Show>
                  <div class="field-hint">Shown to people you invite or share with.</div>
                  <div class="field-hint">
                    User ID: <code>{shortId(identity().user_id ?? undefined) || "(no id on any server yet)"}</code>
                    <span class="admin-identity-facts">
                      &nbsp;({(identity().caps ?? []).join(", ") || "Capabilities: none"})
                    </span>
                  </div>
                </div>
                <div class="form-field">
                  <div class="header-row header-row-tight header-row-inline">
                    <div class="field-label">Your devices</div>
                    <button
                      class="btn-icon btn-icon-sm"
                      type="button"
                      onClick={refreshDevices}
                      title="Refresh device list"
                      aria-label="Refresh device list"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                        <path d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2v1z" />
                        <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466z" />
                      </svg>
                    </button>
                  </div>
                  <For each={devices()}>
                    {(c) => (
                      <div class="control-row admin-device-row">
                        <Show
                          when={renamingClientId() === c.client_id}
                          fallback={
                            <>
                              <div class="code-box">
                                {c.label ?? "(unnamed device)"} — {shortId(c.client_id)}
                                <Show when={c.client_id === clientId()}>
                                  <span class="admin-device-self"> · this device</span>
                                </Show>
                              </div>
                              <button
                                class="btn-icon btn-icon-sm"
                                type="button"
                                onClick={() => { setRenameInput(c.label ?? ""); setRenamingClientId(c.client_id); }}
                                title={`Rename ${c.label ?? "this device"}`}
                                aria-label={`Rename ${c.label ?? "this device"}`}
                              >
                                <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                                  <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" />
                                </svg>
                              </button>
                            </>
                          }
                        >
                          <input
                            type="text"
                            autofocus
                            value={renameInput()}
                            onInput={(e) => setRenameInput(e.currentTarget.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") saveClientLabel(c.client_id);
                              else if (e.key === "Escape") setRenamingClientId(null);
                            }}
                            placeholder="e.g. phone, laptop"
                          />
                          <button class="btn-primary btn-xs" type="button" onClick={() => saveClientLabel(c.client_id)}>Save</button>
                          <button class="btn-xs" type="button" onClick={() => setRenamingClientId(null)}>Cancel</button>
                        </Show>
                      </div>
                    )}
                  </For>
                  <Show when={deviceError()}>
                    <div class="field-error">{deviceError()}</div>
                  </Show>
                  <Show when={devices().length === 0}>
                    <div class="field-hint">No devices found — click Refresh.</div>
                  </Show>
                </div>
                <div class="control-row">
                  <button class="btn-primary" type="button" onClick={() => setShowGrantModal(true)}>+ Create join link</button>
                </div>
              </>
            )}
          </Show>
          <For each={needsGrantEndpoints()}>
            {(ep) => (
              <div class="form-field">
                <div class="field-hint">Not registered on {ep.host || "this server"} yet.</div>
                <button class="btn-primary" type="button" onClick={() => setJoiningEndpointId(ep.id)}>Join</button>
              </div>
            )}
          </For>
          <Show when={clientId()}>
            <div class="form-field">
              <div class="field-label">Client ID</div>
              <div class="code-box">{clientId()}</div>
              <div class="field-hint">Identifies this device's keypair. Assigned automatically, shared across every server it registers with.</div>
            </div>
          </Show>
          <div class="control-row">
            <button type="button" disabled={syncStatus() !== "connected"} onClick={() => syncClient.forceFullSync()}>
              Refresh from server
            </button>
            <button type="button" disabled={syncStatus() !== "connected"} onClick={() => syncClient.forcePushAll()}>
              Push all to server
            </button>
            <Show when={connectedServerId()}>
              <span class="field-hint">server id {connectedServerId()}</span>
            </Show>
          </div>
        </div>

        <div class="admin-section">
          <div class="header-row">
            <h2>Sync servers</h2>
            <button type="button" onClick={addEndpoint}>+ Add</button>
          </div>
          <For each={endpoints()}>
            {(ep) => {
              const status = () => statuses()[ep.id] as EndpointStatus | undefined;
              const phase = () => status()?.phase ?? (ep.enabled ? "connecting" : "disabled");
              const wsUrl = () => `${ep.secure ? "wss" : "ws"}://${ep.host || "…"}:${ep.port}/sync`;
              const httpsUrl = () => `${ep.secure ? "https" : "http"}://${ep.host || "…"}:${ep.port}`;
              const connectedId = () => status()?.serverId ?? ep.last_server_id;
              const expanded = () => expandedIds().has(ep.id);
              return (
                <div class={`panel endpoint-card ${statusClass(status(), phase())}`}>
                  <div class="endpoint-header" classList={{ collapsed: !expanded() }}>
                    <button
                      class="btn-icon btn-icon-sm btn-icon-quiet"
                      type="button"
                      onClick={() => toggleExpanded(ep.id)}
                      aria-expanded={expanded()}
                      aria-label={`${expanded() ? "Collapse" : "Expand"} ${ep.host || "server"} settings`}
                    >
                      <svg class="endpoint-expand-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style={`transform: rotate(${expanded() ? 90 : 0}deg)`}>
                        <polyline points="9 18 15 12 9 6"/>
                      </svg>
                    </button>
                    {/* A title on a span is not announced reliably, so the
                        state also goes in as text only a reader sees. */}
                    <span class="status-dot" title={statusLabel(status(), phase())} aria-hidden="true" />
                    <span class="sr-only">{statusLabel(status(), phase())}</span>
                    <input
                      type="checkbox"
                      class="endpoint-enabled"
                      aria-label={`Sync with ${ep.host || "this server"}`}
                      checked={ep.enabled}
                      onChange={(e) => updateEndpoint(ep.id, { enabled: e.currentTarget.checked })}
                    />
                    <input
                      class="endpoint-host"
                      type="text"
                      aria-label="Server hostname"
                      value={ep.host}
                      placeholder="hostname"
                      onBlur={(e) => updateEndpoint(ep.id, { host: e.currentTarget.value.trim() })}
                    />
                    <span class="endpoint-sep" aria-hidden="true">:</span>
                    <input
                      class="endpoint-port"
                      type="number"
                      aria-label="Server port"
                      value={ep.port}
                      placeholder="port"
                      onBlur={(e) => {
                        const n = parseInt(e.currentTarget.value);
                        updateEndpoint(ep.id, { port: isNaN(n) ? 443 : n });
                      }}
                    />
                    <label class="check-label">
                      <input
                        type="checkbox"
                        checked={ep.secure}
                        onChange={(e) => updateEndpoint(ep.id, { secure: e.currentTarget.checked })}
                      />
                      TLS
                    </label>
                    <button class="btn-icon btn-icon-sm btn-icon-quiet tone-danger" type="button" onClick={() => deleteEndpoint(ep.id)}>✕</button>
                  </div>
                  <Show when={!expanded()}>
                    <div class="endpoint-collapsed-ellipsis" aria-hidden="true">. . .</div>
                  </Show>

                  <Show when={expanded()}>
                    <div class="endpoint-urls">
                      <span class="chip chip-mono"><span class="endpoint-url-proto">WS</span>{wsUrl()}</span>
                      <span class="chip chip-mono"><span class="endpoint-url-proto">HTTP</span>{httpsUrl()}</span>
                    </div>

                    <div class="endpoint-status-row">
                      <span class="status-dot" />
                      <span>{statusLabel(status(), phase())}</span>
                      <Show when={status()?.message}>
                        <span> — {status()!.message}</span>
                      </Show>
                      <Show when={connectedId()}>
                        <span> — server id {shortId(connectedId())}</span>
                      </Show>
                    </div>
                    <Show when={ep.secure && /^[\d.]+$|^[0-9a-f:]+$/i.test(ep.host)}>
                      <div class="field-hint endpoint-hint">TLS certificates are issued for hostnames, not IPs — try disabling TLS for this address.</div>
                    </Show>

                    <Show when={phase() === "variant_mismatch"}>
                      <div class="callout tone-danger endpoint-conflict">
                        <div class="endpoint-conflict-msg">
                          This server is <code class="code">{status()?.serverVariant}</code>, but this client is built for{" "}
                          <code class="code">{status()?.clientVariant}</code>. Refusing to connect — a dev client talking to a prod
                          server (or the reverse) would write live data to the wrong place.
                        </div>
                        <div class="control-row">
                          <button
                            class="btn-sm"
                            type="button"
                            onClick={() => updateEndpoint(ep.id, { enabled: false })}
                          >
                            Disable
                          </button>
                        </div>
                      </div>
                    </Show>

                    <Show when={phase() === "conflict"}>
                      <div class="callout tone-danger endpoint-conflict">
                        <div class="endpoint-conflict-msg">
                          Server ID changed from <code class="code">{shortId(status()?.knownId)}</code> to <code class="code">{shortId(status()?.newId)}</code>
                        </div>
                        <div class="control-row">
                          <button
                            class="btn-primary btn-sm"
                            type="button"
                            onClick={() => updateEndpoint(ep.id, { last_server_id: status()?.newId ?? null })}
                          >
                            Accept new server
                          </button>
                          <button
                            class="btn-sm"
                            type="button"
                            onClick={() => updateEndpoint(ep.id, { enabled: false })}
                          >
                            Disable
                          </button>
                        </div>
                      </div>
                    </Show>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={endpoints().length === 0}>
            <div class="empty-note">No sync servers configured. Click + Add to get started.</div>
          </Show>
        </div>

        <div class="admin-section">
          <div class="header-row header-row-inline">
            <h2>Backup &amp; restore</h2>
            {/* Narrow screens cannot spare four lines for an explainer nobody
                needs twice, so they keep it behind this. */}
            <button
              class="btn-icon btn-help"
              type="button"
              aria-label="About backup and restore"
              aria-expanded={showBackupHelp()}
              aria-controls="backup-help"
              onClick={() => setShowBackupHelp((v) => !v)}
            >
              ?
            </button>
          </div>
          <div
            id="backup-help"
            class={`form-field help-note ${showBackupHelp() ? "help-note-open" : ""}`}
          >
            <div class="field-hint">
              Moving data between two servers (e.g. dev and prod)? Export All here while
              connected to the source server, then Import that file while connected to the
              target. Existing data on the target is never wiped — matching IDs are updated,
              new IDs are added, and deletions recorded since the export are replayed.
            </div>
          </div>
          <div class="control-row">
            <button
              type="button"
              onClick={async () => {
                const data = await exportAllData();
                const date = new Date().toISOString().slice(0, 10);
                triggerDownload(data, `listr-${date}.json`);
              }}
            >
              Export All
            </button>
            <button type="button" onClick={() => setShowImport(true)}>
              Import…
            </button>
          </div>
        </div>

        <div class="admin-section">
          <h2>About</h2>
          <div class="form-field">
            <div class="header-row header-row-tight">
              <div class="field-label">Client build</div>
              <ForceUpdateButton />
            </div>
            <div class="code-box">{formatBuildTime(__BUILD_TIME__)} · protocol v{PROTOCOL_VERSION}</div>
            <div class="field-hint">Build timestamp and sync protocol version of this client.<br/>Update Now clears local cache and reloads from the server!</div>
          </div>
        </div>
      </div>
      <ImportModal open={showImport()} onClose={() => setShowImport(false)} scope={{ type: "global" }} />
      <Show when={primaryEndpointId() && primaryIdentity()}>
        <GrantModal
          open={showGrantModal()}
          onClose={() => setShowGrantModal(false)}
          endpointId={primaryEndpointId()!}
          serverId={primaryIdentity()!.server_id}
          myCaps={primaryIdentity()!.caps}
          myDisplayName={primaryIdentity()!.display_name}
        />
      </Show>
      <Show when={joiningEndpointId()}>
        <RedeemGrantModal
          open={joiningEndpointId() !== null}
          onClose={() => setJoiningEndpointId(null)}
          endpointId={joiningEndpointId()!}
        />
      </Show>
    </div>
  );
};

export default AdminPage;
