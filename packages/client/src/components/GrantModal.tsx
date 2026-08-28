import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import QRCode from "qrcode";
import Modal from "./Modal.js";
import { syncClient } from "../sync/SyncClient.js";
import { buildJoinUrl } from "../sync/joinLink.js";

interface Props {
  open: boolean;
  onClose: () => void;
  endpointId: string;
  serverId: string;
  /** This user's own caps on this server — gates which grant kinds are offered. */
  myCaps: string[];
  myDisplayName: string | null;
}

type GrantKind = "invite" | "device" | "share" | "guest";

const KIND_LABELS: Record<GrantKind, string> = {
  invite: "Invite user",
  guest: "New guest",
  device: "Add device",
  share: "Share board",
};

const KIND_HINTS: Record<GrantKind, string> = {
  invite: "Creates a real account for them, as your child in the tree. They can invite others too if you allow it below.",
  guest: "Creates a limited account for them — same as invite, but they can't invite anyone else (§7.4). Good for texting a shopping list.",
  device: "Registers a new device (phone, laptop, …) to YOUR OWN existing account.",
  share: "Hands one more sync key to someone who already has an account here — no new identity involved.",
};

// The greeting is whatever the recipient reads on the join screen, so the
// example that helps depends entirely on who that is: a device grant is
// addressed to yourself, an invite is a pitch to a stranger, and a share
// names the thing being shared.
const KIND_GREETING_PLACEHOLDERS: Record<GrantKind, string> = {
  invite: "e.g. Use the list management app",
  guest: "e.g. Create guest account on the list management app",
  device: "e.g. Hello me, this is another of my devices",
  share: "e.g. Our shopping list",
};

/** Grant creation UI (auth-design.md §6, §8.2 scope B). Gated by the caller
 * on the 'invite' cap for showing invite/guest at all — but the kind
 * selector itself also hides them if myCaps lacks 'invite', since a
 * component reused elsewhere shouldn't assume its caller always gates
 * correctly, and the server enforces it either way. */
const GrantModal: Component<Props> = (props) => {
  const [kind, setKind] = createSignal<GrantKind>("device");
  const [alsoInvite, setAlsoInvite] = createSignal(false);
  const [payload, setPayload] = createSignal("");
  const [greeting, setGreeting] = createSignal("");
  const [displayName, setDisplayName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [link, setLink] = createSignal<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [urlCopied, setUrlCopied] = createSignal(false);
  let urlCopyTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (urlCopyTimer) clearTimeout(urlCopyTimer); });

  const canInvite = () => props.myCaps.includes("invite");
  const needsDisplayNamePrompt = () => (kind() === "invite" || kind() === "guest") && !props.myDisplayName;

  createEffect(() => {
    if (!props.open) {
      setKind("device");
      setAlsoInvite(false);
      setPayload("");
      setGreeting("");
      setDisplayName("");
      setError(null);
      setLink(null);
      setQrDataUrl(null);
      setBusy(false);
    }
  });

  createEffect(() => {
    if (!props.open) return;
    const unsubscribe = syncClient.onGrantReply(props.endpointId, (msg) => {
      if (msg.type === "grant_created") {
        setBusy(false);
        buildJoinUrl(props.serverId, msg.grant_id, msg.secret).then(async (url) => {
          setLink(url);
          const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256, errorCorrectionLevel: "M" });
          setQrDataUrl(dataUrl);
        });
      } else if (msg.type === "error") {
        setBusy(false);
        setError(msg.message ?? "Couldn't create that grant.");
      }
    });
    onCleanup(unsubscribe);
  });

  const submit = async () => {
    setError(null);
    if (needsDisplayNamePrompt() && displayName().trim()) {
      syncClient.setDisplayName(props.endpointId, displayName().trim());
    }
    setBusy(true);
    syncClient.createGrant(props.endpointId, {
      kind: kind(),
      caps: kind() === "invite" ? (alsoInvite() ? ["sync", "invite"] : ["sync"]) : undefined,
      payload: payload().trim() || undefined,
      greeting: greeting().trim() || null,
    });
  };

  const copyUrl = () => {
    const url = link();
    if (!url) return;
    navigator.clipboard.writeText(url).catch(console.error);
    setUrlCopied(true);
    if (urlCopyTimer) clearTimeout(urlCopyTimer);
    urlCopyTimer = setTimeout(() => setUrlCopied(false), 2000);
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="grant-modal">
      <h2>Create a join link</h2>

      <Show when={!link()} fallback={
        <>
          <p class="field-hint">Share this link or QR code. It works once, and expires in 24 hours.</p>
          <Show when={qrDataUrl()} fallback={<div class="share-loading">Generating…</div>}>
            <div class="share-qr-wrapper">
              <img class="share-qr-code" src={qrDataUrl()!} alt="Join QR code" />
            </div>
            <div class="share-key-section">
              <div class="share-key-row">
                <span class="share-url-text">{link()}</span>
                <button class="btn btn-xs" type="button" onClick={copyUrl}>{urlCopied() ? "Copied!" : "Copy"}</button>
              </div>
            </div>
          </Show>
          <div class="modal-actions">
            <button class="btn-primary" type="button" onClick={props.onClose}>Done</button>
          </div>
        </>
      }>
        <div class="admin-field">
          <label class="field-label">What kind of link?</label>
          <select class="input" value={kind()} onChange={(e) => setKind(e.currentTarget.value as GrantKind)}>
            <option value="device">{KIND_LABELS.device}</option>
            <option value="share">{KIND_LABELS.share}</option>
            <Show when={canInvite()}>
              <option value="invite">{KIND_LABELS.invite}</option>
              <option value="guest">{KIND_LABELS.guest}</option>
            </Show>
          </select>
          <div class="field-hint" style="margin-top: 4px">{KIND_HINTS[kind()]}</div>
        </div>

        <Show when={kind() === "invite"}>
          <div class="admin-field">
            <label style="display:flex; align-items:center; gap:6px">
              <input type="checkbox" checked={alsoInvite()} onChange={(e) => setAlsoInvite(e.currentTarget.checked)} />
              Let them invite others too
            </label>
          </div>
        </Show>

        <Show when={kind() === "share" || kind() === "guest"}>
          <div class="admin-field">
            <label class="field-label">Sync key to hand over</label>
            <input class="input" value={payload()} onInput={(e) => setPayload(e.currentTarget.value)} placeholder="paste a sync key" />
            <div class="field-hint">Leave blank to create the account without handing over any data yet.</div>
          </div>
        </Show>

        <div class="admin-field">
          <label class="field-label">Message</label>
          <input class="input" value={greeting()} onInput={(e) => setGreeting(e.currentTarget.value)} placeholder={KIND_GREETING_PLACEHOLDERS[kind()]} />
        </div>

        <Show when={needsDisplayNamePrompt()}>
          <div class="admin-field">
            <label class="field-label">Your name</label>
            <input class="input" value={displayName()} onInput={(e) => setDisplayName(e.currentTarget.value)} placeholder="they'll see this name" />
            <div class="field-hint">A nickname, not your real name if you'd rather not — they'll see it on the invite.</div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="field-error">{error()}</div>
        </Show>

        <div class="modal-actions">
          <button class="btn-ghost" type="button" onClick={props.onClose}>Cancel</button>
          <button class="btn-primary" type="button" disabled={busy()} onClick={submit}>{busy() ? "Creating…" : "Create link"}</button>
        </div>
      </Show>
    </Modal>
  );
};

export default GrantModal;
