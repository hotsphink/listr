import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import type { Board } from "@listr/shared";
import QRCode from "qrcode";
import Modal from "./Modal.js";
import { updateBoard } from "../db/operations.js";
import { makeShareUrl, type SharePayload } from "../sync/shareToken.js";

function generateShareKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Props {
  open: boolean;
  onClose: () => void;
  board: Board | undefined;
}

const BoardShareModal: Component<Props> = (props) => {
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = createSignal<string | null>(null);
  const [urlCopied, setUrlCopied] = createSignal(false);
  let urlCopyTimer: ReturnType<typeof setTimeout> | null = null;
  onCleanup(() => { if (urlCopyTimer) clearTimeout(urlCopyTimer); });

  createEffect(() => {
    const board = props.board;
    if (!props.open || !board) {
      setShareUrl(null);
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    (async () => {
      let key = board.sync_key;
      if (!key) {
        key = generateShareKey();
        await updateBoard(board.id, { sync_key: key });
      }
      if (cancelled) return;

      const payload: SharePayload = { v: 1, sk: key, bid: board.id, bn: board.name };
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
      <h2>Share "{props.board?.name}"</h2>
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
