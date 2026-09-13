import { type Component, createSignal, createEffect, Show } from "solid-js";
import { useNavigate } from "@solidjs/router";
import Modal from "./Modal.js";
import { parseJoinInput, joinRoutePath } from "../sync/joinLink.js";
import { useQrScanner } from "../hooks/useQrScanner.js";

/**
 * Camera front-end for join links. It only parses and routes: resolving the
 * server, peeking the grant, and redeeming it all belong to JoinPage, which a
 * link opened from a messaging app reaches directly. This exists for the case
 * where the link is on someone else's screen rather than in your inbox.
 */
const ScanShareModal: Component<{ open: boolean; onClose: () => void }> = (props) => {
  let videoRef!: HTMLVideoElement;
  let canvasRef!: HTMLCanvasElement;

  const [manualLink, setManualLink] = createSignal("");
  const [manualError, setManualError] = createSignal<string | null>(null);
  const navigate = useNavigate();

  const go = (raw: string): boolean => {
    const link = parseJoinInput(raw);
    if (!link) return false;
    scanner.stop();
    props.onClose();
    navigate(joinRoutePath(link));
    return true;
  };

  const scanner = useQrScanner({
    videoRef: () => videoRef,
    canvasRef: () => canvasRef,
    onDecode: (text) => { go(text); },
  });

  // Use createEffect (not onMount) so we react every time props.open becomes true.
  // onMount fires once at component mount, but ScanShareModal is always in the tree,
  // so we'd miss subsequent opens.
  createEffect(() => {
    if (!props.open) return;
    setManualLink("");
    setManualError(null);
    scanner.start();
  });

  const handleManualSubmit = (e: Event) => {
    e.preventDefault();
    if (!go(manualLink().trim())) setManualError("Not a valid share link.");
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="scan-share">
      <h2>Receive Shared Board</h2>

      <Show
        when={!scanner.cameraError()}
        fallback={
          <div class="scan-no-camera field-hint">
            Camera unavailable: {scanner.cameraError()}
          </div>
        }
      >
        <div class="scan-preview-wrapper">
          <video ref={videoRef!} class="scan-preview" playsinline aria-label="Camera preview for scanning a share code" />
          <canvas ref={canvasRef!} hidden />
          <div class="scan-overlay-corner tl" /><div class="scan-overlay-corner tr" />
          <div class="scan-overlay-corner bl" /><div class="scan-overlay-corner br" />
        </div>
        <div class="field-hint scan-hint">Point at the share QR code</div>
      </Show>

      <form onSubmit={handleManualSubmit} class="scan-manual-form">
        <div class="scan-manual-label">Or paste a share link:</div>
        <div class="control-row">
          <input
            value={manualLink()}
            onInput={(e) => { setManualLink(e.currentTarget.value); setManualError(null); }}
            placeholder="https://…"
            autocomplete="off"
            spellcheck={false}
          />
          <button class="btn-primary" type="submit">Open</button>
        </div>
        <Show when={manualError()}>
          <div class="field-error" role="alert">{manualError()}</div>
        </Show>
      </form>

      <div class="actions">
        <button class="btn-ghost" type="button" onClick={props.onClose}>Cancel</button>
      </div>
    </Modal>
  );
};

export default ScanShareModal;
