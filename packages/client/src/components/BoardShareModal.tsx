import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import type { Board } from "@listr/shared";
import QRCode from "qrcode";
import Modal from "./Modal.js";
import { db } from "../db/database.js";
import { updateBoard } from "../db/operations.js";
import { makeShareUrl, generateShareKey, type SharePayload } from "../sync/shareToken.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Share one specific board — generates+persists a sync_key on it if it doesn't have one. */
  board?: Board;
  /**
   * Share a whole board group by its sync_key directly (no board id), so the set of
   * boards under that key — and any future additions/removals — stays synced for
   * whoever accepts. Used for e.g. sharing your entire "My Boards" group.
   */
  group?: { key: string; name: string };
}

const BoardShareModal: Component<Props> = (props) => {
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [urlCopied, setUrlCopied] = createSignal(false);
  // Other boards that would ride along under the same sync key — null while
  // still computing, so the warning doesn't flash a wrong number. See §7.6:
  // `sk` conveys the whole namespace, not just the one board being shared.
  const [otherBoardCount, setOtherBoardCount] = createSignal<number | null>(null);
  let urlCopyTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (urlCopyTimer) clearTimeout(urlCopyTimer); });

  const title = () => props.board?.name ?? props.group?.name ?? "";

  createEffect(() => {
    const board = props.board;
    const group = props.group;
    if (!props.open || (!board && !group)) {
      setShareUrl(null);
      setQrDataUrl(null);
      setOtherBoardCount(null);
      return;
    }

    let cancelled = false;
    (async () => {
      let payload: SharePayload;
      if (board) {
        let key = board.sync_key;
        if (!key) {
          key = generateShareKey();
          await updateBoard(board.id, { sync_key: key });
        }
        payload = { v: 1, sk: key, bid: board.id, bn: board.name };

        // Count other boards riding along under this same key so the dialog
        // can be honest about what `sk` actually hands over (§7.6). The
        // fallback key for an unkeyed board is now the server-assigned home
        // key (§3.1/§8.1) — sync_config.sync_key is retired.
        const identities = await db.server_identity.toArray();
        const homeKey = identities.find((i) => i.state === "active" && i.home_key)?.home_key ?? "";
        const allBoards = await db.boards.toArray();
        const others = allBoards.filter((b) => b.id !== board.id && (b.sync_key ?? homeKey) === key);
        if (!cancelled) setOtherBoardCount(others.length);
      } else {
        payload = { v: 1, sk: group!.key, bid: "", bn: group!.name };
      }
      if (cancelled) return;

      const url = makeShareUrl(payload);
      setShareUrl(url);

      // Encode the URL itself in the QR so phone cameras can open the app directly
      const dataUrl = await QRCode.toDataURL(url, { margin: 2, width: 256, errorCorrectionLevel: "M" });
      if (!cancelled) setQrDataUrl(dataUrl);
    })();
    onCleanup(() => { cancelled = true; });
  });

  const copyUrl = () => {
    const url = shareUrl();
    if (!url) return;
    navigator.clipboard.writeText(url).catch(console.error);
    setUrlCopied(true);
    if (urlCopyTimer) clearTimeout(urlCopyTimer);
    urlCopyTimer = setTimeout(() => setUrlCopied(false), 2000);
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="board-share">
      <h2>Share "{title()}"</h2>
      <Show when={props.group}>
        <div class="field-hint" style="margin-bottom: 8px">
          Anyone who accepts this link gets the whole group — boards added or removed later stay in sync too.
        </div>
      </Show>
      <Show when={props.board && otherBoardCount() !== null}>
        <div class="field-hint" style="margin-bottom: 8px">
          {otherBoardCount()! > 0
            ? `This link shares the whole namespace this board lives in — it also shares ${otherBoardCount()} other board${otherBoardCount()! > 1 ? "s" : ""}.`
            : "This board is alone in its sync namespace, so this link shares only it."}
        </div>
      </Show>
      <Show
        when={qrDataUrl()}
        fallback={<div class="share-loading">Generating…</div>}
      >
        <div class="share-qr-wrapper">
          <img class="share-qr-code" src={qrDataUrl()!} alt="Share QR code" />
        </div>
        <div class="share-key-section">
          <div class="field-hint" style="margin-bottom: 6px">
            Scan the QR code, or copy the link to share via any app.
          </div>
          <div class="share-key-row">
            <span class="share-url-text">{shareUrl()}</span>
            <button class="btn btn-xs" type="button" onClick={copyUrl}>
              {urlCopied() ? "Copied!" : "Copy"}
            </button>
          </div>
        </div>
      </Show>
      <div class="modal-actions">
        <button class="btn-primary" type="button" onClick={props.onClose}>Done</button>
      </div>
    </Modal>
  );
};

export default BoardShareModal;
