import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import type { Board } from "@listr/shared";
import QRCode from "qrcode";
import Modal from "./Modal.js";
import { db } from "../db/database.js";
import { updateBoard } from "../db/operations.js";
import { syncClient } from "../sync/SyncClient.js";
import { generateShareKey } from "../sync/syncKeys.js";
import { buildJoinUrl } from "../sync/joinLink.js";
import { primaryEndpointId, primaryIdentity } from "../sync/primaryConnection.js";
import { setSidebarOpen } from "../store/sidebarStore.js";

/** Board shares outlive a texted invite, so they get a week rather than
 * createGrant's 24 hour default. */
const SHARE_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** How many people one share link admits. "Anyone" is a ceiling, not a
 * promise: the link still expires, and the sharer can revoke the key. */
const MANY_USES = 100;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Share one specific board, generating and persisting a sync_key on it if
   * it does not have one. */
  board?: Board;
  /**
   * Share a whole board group by its sync_key directly, with no board id, so
   * the set of boards under that key, along with any later additions and
   * removals, stays synced for whoever accepts. Used for sharing an entire
   * group such as "My Boards".
   */
  group?: { key: string; name: string };
}

const BoardShareModal: Component<Props> = (props) => {
  const navigate = useNavigate();

  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [urlCopied, setUrlCopied] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // One link admits one person by default, so a texted link cannot be reused
  // by whoever else sees the message.
  const [multiUse, setMultiUse] = createSignal(false);
  // The sync key this link hands over, resolved once and shared by the grant
  // and the ride-along count so the two cannot describe different keys.
  const [sharedKey, setSharedKey] = createSignal<string | null>(null);
  // Other boards that would ride along under the same sync key. null while
  // still computing, so the warning never flashes a wrong number. The key
  // conveys the whole namespace, not just the one board being shared.
  const [otherBoardCount, setOtherBoardCount] = createSignal<number | null>(null);
  let urlCopyTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (urlCopyTimer) clearTimeout(urlCopyTimer); });

  const title = () => props.board?.name ?? props.group?.name ?? "";

  /** A guest grant mints the recipient an account, which is the only way
   * someone with no account on this server can sync at all. Issuing one needs
   * the `invite` cap; without it the best available is a `share` grant, which
   * hands a key to someone who already has an account here. */
  const canInvite = () => primaryIdentity()?.caps.includes("invite") ?? false;
  const connected = () => primaryEndpointId() !== null && primaryIdentity() !== null;

  // Reset on close so the next open never shows the previous board's link.
  createEffect(() => {
    if (props.open) return;
    setShareUrl(null);
    setQrDataUrl(null);
    setError(null);
    setMultiUse(false);
    setSharedKey(null);
    setOtherBoardCount(null);
  });

  // Resolve the key being shared, generating and persisting one for a board
  // that has none. Separate from grant creation so re-issuing a grant, when
  // the use count changes, does not re-run the write.
  createEffect(() => {
    const board = props.board;
    const group = props.group;
    if (!props.open || (!board && !group)) return;
    if (!board) { setSharedKey(group!.key); return; }
    if (board.sync_key) { setSharedKey(board.sync_key); return; }

    let cancelled = false;
    (async () => {
      const key = generateShareKey();
      await updateBoard(board.id, { sync_key: key });
      if (!cancelled) setSharedKey(key);
    })();
    onCleanup(() => { cancelled = true; });
  });

  // Count other boards riding along under this same key, so the dialog can be
  // honest about what the key hands over. The fallback key for an unkeyed
  // board is the server-assigned home key.
  createEffect(() => {
    const board = props.board;
    const key = sharedKey();
    if (!props.open || !board || !key) return;

    let cancelled = false;
    (async () => {
      const identities = await db.server_identity.toArray();
      const homeKey = identities.find((i) => i.state === "active" && i.home_key)?.home_key ?? "";
      const allBoards = await db.boards.toArray();
      const others = allBoards.filter((b) => b.id !== board.id && (b.sync_key ?? homeKey) === key);
      if (!cancelled) setOtherBoardCount(others.length);
    })();
    onCleanup(() => { cancelled = true; });
  });

  // Receive the create_grant reply and turn it into a link plus QR.
  createEffect(() => {
    if (!props.open) return;
    const epId = primaryEndpointId();
    const identity = primaryIdentity();
    if (!epId || !identity) return;

    let cancelled = false;
    const unsubscribe = syncClient.onGrantReply(epId, (msg) => {
      if (cancelled) return;
      if (msg.type === "grant_created") {
        buildJoinUrl(identity.server_id, msg.grant_id, msg.secret, props.board?.id)
          .then(async (url) => {
            if (cancelled) return;
            setShareUrl(url);
            const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256, errorCorrectionLevel: "M" });
            if (!cancelled) setQrDataUrl(dataUrl);
          })
          .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
      } else if (msg.type === "error") {
        setError(msg.message ?? "Couldn't create a share link.");
      }
    });
    onCleanup(() => { cancelled = true; unsubscribe(); });
  });

  // Issue the grant. Reruns when the use-count choice changes, since that is
  // baked into the grant rather than into the URL, so a different answer needs
  // a different grant.
  createEffect(() => {
    const key = sharedKey();
    const uses = multiUse() ? MANY_USES : 1;
    const kind = canInvite() ? "guest" : "share";
    const name = title();
    // Name the key only for a deliberate group. Naming an individual board's
    // key would promote it to its own sidebar heading on the recipient's
    // device, when it belongs in the generic shared bucket.
    const payloadName = props.group ? name : undefined;
    const epId = primaryEndpointId();
    if (!props.open || !key || !epId || !primaryIdentity()) return;

    setShareUrl(null);
    setQrDataUrl(null);
    setError(null);
    try {
      syncClient.createGrant(epId, {
        kind,
        payload: key,
        payloadName,
        greeting: name,
        expiresAt: Date.now() + SHARE_GRANT_TTL_MS,
        usesRemaining: uses,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  });

  const copyUrl = () => {
    const url = shareUrl();
    if (!url) return;
    navigator.clipboard.writeText(url).catch(console.error);
    setUrlCopied(true);
    if (urlCopyTimer) clearTimeout(urlCopyTimer);
    urlCopyTimer = setTimeout(() => setUrlCopied(false), 2000);
  };

  const goToAdmin = () => {
    props.onClose();
    setSidebarOpen(false);
    navigate("/admin");
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="board-share">
      <h2>Share "{title()}"</h2>

      <Show when={connected()} fallback={
        <>
          <p class="field-hint field-hint-lead">
            {primaryIdentity()
              ? "Sharing needs a live connection to your sync server, and there isn't one right now."
              : "Sharing needs a sync server. A share link works by giving someone access on the server holding this board, so there has to be one."}
          </p>
          <div class="actions actions-center">
            <button class="btn-ghost" type="button" onClick={props.onClose}>Cancel</button>
            <button class="btn-primary" type="button" onClick={goToAdmin}>
              {primaryIdentity() ? "Check sync" : "Set up sync"}
            </button>
          </div>
        </>
      }>
        <Show when={props.group}>
          <div class="field-hint field-hint-lead">
            Anyone who accepts this link gets the whole group. Boards added or removed later stay in sync too.
          </div>
        </Show>
        <Show when={props.board && otherBoardCount() !== null}>
          <div class="field-hint field-hint-lead">
            {otherBoardCount()! > 0
              ? `This link shares the whole namespace this board lives in, so it also shares ${otherBoardCount()} other board${otherBoardCount()! > 1 ? "s" : ""}.`
              : "This board is alone in its sync namespace, so this link shares only it."}
          </div>
        </Show>

        <Show when={!canInvite()}>
          <div class="field-hint field-hint-lead">
            You can't create accounts on this server, so this link only works for someone who already has one.
          </div>
        </Show>

        <fieldset class="form-field share-uses">
          <legend class="field-label">Who can use this link</legend>
          <label class="check-label">
            <input type="radio" name="share-uses" checked={!multiUse()} onChange={() => setMultiUse(false)} />
            One person
          </label>
          <label class="check-label">
            <input type="radio" name="share-uses" checked={multiUse()} onChange={() => setMultiUse(true)} />
            Anyone with the link
          </label>
        </fieldset>

        <Show when={error()}>
          <div class="field-error" role="alert">{error()}</div>
        </Show>

        <Show
          when={qrDataUrl()}
          fallback={<Show when={!error()}><div class="empty-note empty-note-center">Generating…</div></Show>}
        >
          <div class="share-qr-wrapper">
            <img class="share-qr-code" src={qrDataUrl()!} alt="Share QR code" />
          </div>
          <div class="share-key-section">
            <div class="field-hint field-hint-lead">
              Scan the QR code, or copy the link to share via any app. It expires in a week.
            </div>
            <div class="share-key-row">
              <span class="share-url-text">{shareUrl()}</span>
              <button class="btn-xs" type="button" onClick={copyUrl}>
                {urlCopied() ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        </Show>
        <div class="actions">
          <button class="btn-primary" type="button" onClick={props.onClose}>Done</button>
        </div>
      </Show>
    </Modal>
  );
};

export default BoardShareModal;
