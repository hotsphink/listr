import { type Component, Show, createSignal, createEffect } from "solid-js";
import { db } from "../db/database.js";
import type { SyncConfig } from "../db/database.js";
import { syncClient } from "../sync/SyncClient.js";
import { syncStatus, syncStatusMessage } from "../sync/syncStore.js";

function makeClientId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disconnected",
  error: "Error",
};

interface Props {
  open: boolean;
  onClose: () => void;
}

const SyncSettingsModal: Component<Props> = (props) => {
  const [url, setUrl] = createSignal("");
  const [key, setKey] = createSignal("");
  const [enabled, setEnabled] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [savedClientId, setSavedClientId] = createSignal("");

  createEffect(() => {
    if (props.open) {
      db.sync_config.get("default").then((config) => {
        if (config) {
          setUrl(config.sync_url);
          setKey(config.sync_key);
          setEnabled(config.enabled);
          setSavedClientId(config.client_id);
        } else {
          setSavedClientId(makeClientId());
        }
      });
    }
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      const existing = await db.sync_config.get("default");
      const serverChanged = url().trim() !== existing?.sync_url || key().trim() !== existing?.sync_key;
      const config: SyncConfig = {
        id: "default",
        sync_url: url().trim(),
        sync_key: key().trim(),
        client_id: existing?.client_id ?? (savedClientId() || makeClientId()),
        enabled: enabled(),
        last_sync_at: serverChanged ? 0 : (existing?.last_sync_at ?? 0),
      };
      await db.sync_config.put(config);
      if (config.enabled && config.sync_url && config.sync_key) {
        syncClient.connect(config.sync_url, config.sync_key, config.client_id);
      } else {
        syncClient.disconnect();
      }
      props.onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    syncClient.disconnect();
    await db.sync_config.update("default", { enabled: false });
    setEnabled(false);
  };

  const statusColor = () => {
    const s = syncStatus();
    if (s === "connected") return "var(--success)";
    if (s === "connecting") return "#f0a500";
    if (s === "error") return "var(--danger)";
    return "var(--text-dim)";
  };

  return (
    <Show when={props.open}>
      <div class="modal-overlay" onClick={props.onClose}>
        <div class="modal" style="max-width: 420px" onClick={(e) => e.stopPropagation()}>
          <div class="modal-header">
            <h2 class="modal-title">Sync Settings</h2>
            <button class="modal-close" onClick={props.onClose}>✕</button>
          </div>
          <div class="modal-body">
            <div class="sync-status-row">
              <span class="sync-dot" style={`background: ${statusColor()}`} />
              <span class="sync-status-text">
                {STATUS_LABEL[syncStatus()] ?? syncStatus()}
                {syncStatusMessage() ? `: ${syncStatusMessage()}` : ""}
              </span>
            </div>

            <div class="field">
              <label class="field-label">Server URL</label>
              <input
                class="input"
                type="text"
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
                placeholder="wss://finkripper.heron-moth.ts.net:10000"
              />
            </div>

            <div class="field">
              <label class="field-label">Sync Key</label>
              <input
                class="input"
                type="text"
                value={key()}
                onInput={(e) => setKey(e.currentTarget.value)}
                placeholder="shared secret — same on all devices"
              />
              <div class="field-hint">Pick any phrase. All devices with the same key share data.</div>
            </div>

            <label class="checkbox-row">
              <input
                type="checkbox"
                checked={enabled()}
                onChange={(e) => setEnabled(e.currentTarget.checked)}
              />
              Enable sync
            </label>
          </div>
          <div class="modal-footer">
            <Show when={syncStatus() === "connected"}>
              <button class="btn" style="margin-right: auto" onClick={handleDisconnect}>Disconnect</button>
            </Show>
            <button class="btn" onClick={props.onClose}>Cancel</button>
            <button class="btn btn-primary" onClick={handleSave} disabled={saving()}>
              {saving() ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
};

export default SyncSettingsModal;
