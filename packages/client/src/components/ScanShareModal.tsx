import { type Component, createSignal, createEffect, Show } from "solid-js";
import Modal from "./Modal.js";
import { db } from "../db/database.js";
import { markBoardGroup } from "../db/operations.js";
import { parseShareInput, type SharePayload } from "../sync/shareToken.js";
import { useQrScanner } from "../hooks/useQrScanner.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ScanShareModal: Component<Props> = (props) => {
  let videoRef!: HTMLVideoElement;
  let canvasRef!: HTMLCanvasElement;

  const [scanned, setScanned] = createSignal<SharePayload | null>(null);
  const [manualKey, setManualKey] = createSignal("");
  const [manualError, setManualError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const scanner = useQrScanner({
    videoRef: () => videoRef,
    canvasRef: () => canvasRef,
    onDecode: (text) => {
      const payload = parseShareInput(text);
      if (payload) {
        scanner.stop();
        setScanned(payload);
      }
    },
  });

  // Use createEffect (not onMount) so we react every time props.open becomes true.
  // onMount fires once at component mount, but ScanShareModal is always in the tree,
  // so we'd miss subsequent opens.
  createEffect(() => {
    if (!props.open) return;

    // Reset state every time the modal opens
    setScanned(null);
    setManualKey("");
    setManualError(null);
    scanner.start();
  });

  const acceptShare = async (payload: SharePayload) => {
    setSaving(true);
    await db.shared_keys.put({ key: payload.sk, added_at: Date.now(), board_name: payload.bn, server_id: null });
    if (!payload.bid) await markBoardGroup(payload.sk, payload.bn || "Shared Group");
    setSaving(false);
    // Close immediately — the board will appear in the sidebar reactively once sync completes.
    props.onClose();
  };

  const handleManualSubmit = (e: Event) => {
    e.preventDefault();
    const payload = parseShareInput(manualKey().trim());
    if (!payload) { setManualError("Not a valid share key."); return; }
    setManualError(null);
    setScanned(payload);
  };

  const reset = () => {
    setScanned(null);
    setManualKey("");
    setManualError(null);
    // Clearing scanned will re-render the camera section; the createEffect won't
    // re-trigger (props.open hasn't changed), so restart the camera manually.
    scanner.start();
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="scan-share">
      <h2>Receive Shared Board</h2>

      <Show when={!scanned()}>
        <Show
          when={!scanner.cameraError()}
          fallback={
            <div class="scan-no-camera field-hint">
              Camera unavailable: {scanner.cameraError()}
            </div>
          }
        >
          <div class="scan-preview-wrapper">
            <video ref={videoRef!} class="scan-preview" playsinline />
            <canvas ref={canvasRef!} style="display:none" />
            <div class="scan-overlay-corner tl" /><div class="scan-overlay-corner tr" />
            <div class="scan-overlay-corner bl" /><div class="scan-overlay-corner br" />
          </div>
          <div class="field-hint" style="text-align:center; margin: 6px 0 12px">
            Point at the share QR code
          </div>
        </Show>

        <form onSubmit={handleManualSubmit} class="scan-manual-form">
          <div class="scan-manual-label">Or paste a share link or key:</div>
          <div class="scan-manual-row">
            <input
              class="input"
              value={manualKey()}
              onInput={(e) => { setManualKey(e.currentTarget.value); setManualError(null); }}
              placeholder="https://… or bare key"
              autocomplete="off"
              spellcheck={false}
            />
            <button class="btn btn-primary" type="submit">Add</button>
          </div>
          <Show when={manualError()}>
            <div class="field-error">{manualError()}</div>
          </Show>
        </form>

        <div class="modal-actions">
          <button class="btn-ghost" type="button" onClick={props.onClose}>Cancel</button>
        </div>
      </Show>

      <Show when={scanned()}>
        {(payload) => (
          <div class="scan-confirm">
            <div class="scan-confirm-detail">
              <Show when={payload().bn}>
                <div class="scan-board-name">"{payload().bn}"</div>
              </Show>
              <div class="field-hint">Key: <code>{payload().sk}</code></div>
            </div>
            <p>
              {payload().bid
                ? "Subscribe to this board and sync its data?"
                : "Subscribe to this board group and sync it? Boards added to or removed from the group later will stay in sync too."}
            </p>
            <div class="modal-actions">
              <button class="btn-ghost" type="button" onClick={reset}>Back</button>
              <button class="btn-primary" type="button" disabled={saving()} onClick={() => acceptShare(payload())}>
                {saving() ? "Adding…" : payload().bid ? "Add Board" : "Add Group"}
              </button>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
};

export default ScanShareModal;
