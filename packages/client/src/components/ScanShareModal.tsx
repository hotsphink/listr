import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import jsQR from "jsqr";
import Modal from "./Modal.js";
import { db } from "../db/database.js";
import { parseShareInput, type SharePayload } from "../sync/shareToken.js";

interface Props {
  open: boolean;
  onClose: () => void;
}

const ScanShareModal: Component<Props> = (props) => {
  let videoRef!: HTMLVideoElement;
  let canvasRef!: HTMLCanvasElement;

  const [cameraError, setCameraError] = createSignal<string | null>(null);
  const [scanned, setScanned] = createSignal<SharePayload | null>(null);
  const [manualKey, setManualKey] = createSignal("");
  const [manualError, setManualError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  // Use createEffect (not onMount) so we react every time props.open becomes true.
  // onMount fires once at component mount, but ScanShareModal is always in the tree,
  // so we'd miss subsequent opens.
  createEffect(() => {
    if (!props.open) return;

    // Reset state every time the modal opens
    setCameraError(null);
    setScanned(null);
    setManualKey("");
    setManualError(null);
    let active = true;
    let localStream: MediaStream | null = null;

    const scan = () => {
      if (!active || !videoRef || videoRef.readyState < videoRef.HAVE_ENOUGH_DATA) {
        if (active) requestAnimationFrame(scan);
        return;
      }
      const ctx = canvasRef?.getContext("2d", { willReadFrequently: true });
      if (!ctx) { if (active) requestAnimationFrame(scan); return; }
      canvasRef.width = videoRef.videoWidth;
      canvasRef.height = videoRef.videoHeight;
      ctx.drawImage(videoRef, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        const payload = parseShareInput(code.data);
        if (payload) {
          active = false;
          localStream?.getTracks().forEach((t) => t.stop());
          localStream = null;
          setScanned(payload);
          return;
        }
      }
      if (active) requestAnimationFrame(scan);
    };

    (async () => {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (!active) { localStream.getTracks().forEach((t) => t.stop()); return; }
        videoRef.srcObject = localStream;
        // Set muted as a DOM property — the HTML attribute alone is unreliable in Firefox.
        videoRef.muted = true;
        await videoRef.play();
        requestAnimationFrame(scan);
      } catch (e) {
        if (active) {
          active = false;
          setCameraError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    onCleanup(() => {
      active = false;
      localStream?.getTracks().forEach((t) => t.stop());
      if (videoRef) videoRef.srcObject = null;
    });
  });

  const acceptShare = async (payload: SharePayload) => {
    setSaving(true);
    await db.shared_keys.put({ key: payload.sk, added_at: Date.now(), board_name: payload.bn });
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
    // re-trigger (props.open hasn't changed), so we restart the camera manually.
    setCameraError(null);
    let active = true;
    let localStream: MediaStream | null = null;
    const scan = () => {
      if (!active || !videoRef || videoRef.readyState < videoRef.HAVE_ENOUGH_DATA) {
        if (active) requestAnimationFrame(scan);
        return;
      }
      const ctx = canvasRef?.getContext("2d", { willReadFrequently: true });
      if (!ctx) { if (active) requestAnimationFrame(scan); return; }
      canvasRef.width = videoRef.videoWidth;
      canvasRef.height = videoRef.videoHeight;
      ctx.drawImage(videoRef, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) {
        const payload = parseShareInput(code.data);
        if (payload) { active = false; localStream?.getTracks().forEach(t => t.stop()); setScanned(payload); return; }
      }
      if (active) requestAnimationFrame(scan);
    };
    (async () => {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (!active) { localStream.getTracks().forEach(t => t.stop()); return; }
        videoRef.srcObject = localStream;
        videoRef.muted = true;
        await videoRef.play();
        requestAnimationFrame(scan);
      } catch (e) {
        if (active) { active = false; setCameraError(e instanceof Error ? e.message : String(e)); }
      }
    })();
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="scan-share">
      <h2>Receive Shared Board</h2>

      <Show when={!scanned()}>
        <Show
          when={!cameraError()}
          fallback={
            <div class="scan-no-camera field-hint">
              Camera unavailable: {cameraError()}
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
            <p>Subscribe to this board and sync its data?</p>
            <div class="modal-actions">
              <button class="btn-ghost" type="button" onClick={reset}>Back</button>
              <button class="btn-primary" type="button" disabled={saving()} onClick={() => acceptShare(payload())}>
                {saving() ? "Adding…" : "Add Board"}
              </button>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
};

export default ScanShareModal;
