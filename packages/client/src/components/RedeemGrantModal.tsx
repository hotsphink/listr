import { type Component, createSignal, createEffect, onCleanup, Show } from "solid-js";
import Modal from "./Modal.js";
import { syncClient } from "../sync/SyncClient.js";
import { parseJoinInput, hashServerId } from "../sync/joinLink.js";
import { endpointStatuses } from "../store/endpointStatuses.js";
import { useQrScanner } from "../hooks/useQrScanner.js";
import { countUnboundLocalBoards, discardUnboundLocalBoards } from "../db/operations.js";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The endpoint currently sitting in "needs_grant" that this redemption targets. */
  endpointId: string;
}

type Step = "input" | "peeking" | "confirm" | "joining" | "done";

/** AdminPage's "Join" flow, the mirror image of JoinPage. The target server is
 * already known here, being the endpoint sitting in needs_grant, so this only
 * has to accept a link or QR code and confirm its server hash names the same
 * server, rather than resolving a route from scratch. */
const RedeemGrantModal: Component<Props> = (props) => {
  const [pasted, setPasted] = createSignal("");
  const [step, setStep] = createSignal<Step>("input");
  const [error, setError] = createSignal<string | null>(null);
  const [grantInfo, setGrantInfo] = createSignal<{ greeting: string | null; issuerDisplayName: string | null } | null>(null);
  const [unboundBoards, setUnboundBoards] = createSignal(0);
  const [keepChoice, setKeepChoice] = createSignal<"keep" | "discard">("keep");
  const [grantId, setGrantId] = createSignal("");
  const [secret, setSecret] = createSignal("");

  let videoRef!: HTMLVideoElement;
  let canvasRef!: HTMLCanvasElement;

  const scanner = useQrScanner({
    videoRef: () => videoRef,
    canvasRef: () => canvasRef,
    onDecode: (text) => tryUse(text),
  });

  createEffect(() => {
    if (props.open) {
      setPasted("");
      setStep("input");
      setError(null);
      setGrantInfo(null);
      setKeepChoice("keep");
      scanner.start();
    } else {
      scanner.stop();
    }
  });

  createEffect(() => {
    const unsubscribe = syncClient.onGrantReply(props.endpointId, (msg) => {
      if (msg.type === "grant_info") {
        setGrantInfo({ greeting: msg.greeting ?? null, issuerDisplayName: msg.issuer_display_name ?? null });
        countUnboundLocalBoards().then(setUnboundBoards);
        setStep("confirm");
      } else if (msg.type === "error") {
        setError(msg.message ?? "That link didn't work.");
        setStep("input");
      }
    });
    onCleanup(unsubscribe);
  });

  createEffect(() => {
    if (step() !== "joining") return;
    if (endpointStatuses()[props.endpointId]?.phase === "ready") {
      setStep("done");
    }
  });

  async function tryUse(text: string) {
    const parsed = parseJoinInput(text);
    if (!parsed) { setError("Not a valid join link."); return; }
    const knownServerId = endpointStatuses()[props.endpointId]?.serverId;
    if (knownServerId) {
      const hash = await hashServerId(knownServerId);
      if (hash !== parsed.serverHash) {
        setError("This link is for a different server than the one you're connecting to.");
        return;
      }
    }
    scanner.stop();
    setError(null);
    setGrantId(parsed.grantId);
    setSecret(parsed.secret);
    setStep("peeking");
    syncClient.peekGrant(props.endpointId, parsed.grantId, parsed.secret);
  }

  const submitPasted = (e: Event) => {
    e.preventDefault();
    if (pasted().trim()) tryUse(pasted().trim());
  };

  const doJoin = async () => {
    if (unboundBoards() > 0 && keepChoice() === "discard") await discardUnboundLocalBoards();
    setStep("joining");
    syncClient.redeemGrant(props.endpointId, grantId(), secret());
  };

  return (
    <Modal open={props.open} onClose={props.onClose} class="scan-share">
      <h2>Join with a link</h2>

      <Show when={step() === "input"}>
        <Show
          when={!scanner.cameraError()}
          fallback={<div class="scan-no-camera field-hint">Camera unavailable: {scanner.cameraError()}</div>}
        >
          <div class="scan-preview-wrapper">
            <video ref={videoRef!} class="scan-preview" playsinline />
            <canvas ref={canvasRef!} hidden />
          </div>
        </Show>
        <form onSubmit={submitPasted} class="scan-manual-form">
          <div class="scan-manual-label">Or paste a join link:</div>
          <div class="control-row">
            <input value={pasted()} onInput={(e) => setPasted(e.currentTarget.value)} placeholder="https://…" autocomplete="off" spellcheck={false} />
            <button class="btn-primary" type="submit">Use</button>
          </div>
          <Show when={error()}><div class="field-error">{error()}</div></Show>
        </form>
        <div class="actions">
          <button class="btn-ghost" type="button" onClick={props.onClose}>Cancel</button>
        </div>
      </Show>

      <Show when={step() === "peeking"}>
        <div class="receive-syncing">
          <div class="spinner" />
          <div>Looking up the invite…</div>
        </div>
      </Show>

      <Show when={step() === "confirm" && grantInfo()}>
        {(info) => (
          <div class="scan-confirm">
            <Show when={info().issuerDisplayName}>
              <p><strong>{info().issuerDisplayName}</strong> is inviting you with the message</p>
            </Show>
            <Show when={info().greeting}>
              <div class="offer-name">"{info().greeting}"</div>
            </Show>
            <Show when={unboundBoards() > 0}>
              <div class="field-hint field-hint-lead">
                You have {unboundBoards()} local board{unboundBoards() > 1 ? "s" : ""} from before joining.
              </div>
              <label class="check-label">
                <input type="radio" name="redeem-keep" checked={keepChoice() === "keep"} onChange={() => setKeepChoice("keep")} />
                Keep it
              </label>
              <label class="check-label">
                <input type="radio" name="redeem-keep" checked={keepChoice() === "discard"} onChange={() => setKeepChoice("discard")} />
                Discard it
              </label>
            </Show>
            <div class="actions">
              <button class="btn-ghost" type="button" onClick={() => setStep("input")}>Back</button>
              <button class="btn-primary" type="button" onClick={doJoin}>Join</button>
            </div>
          </div>
        )}
      </Show>

      <Show when={step() === "joining"}>
        <div class="receive-syncing">
          <div class="spinner" />
          <div>Joining…</div>
        </div>
      </Show>

      <Show when={step() === "done"}>
        <div class="receive-saved">
          <div class="receive-saved-icon">✓</div>
          <div>You're in!</div>
        </div>
        <div class="actions">
          <button class="btn-primary" type="button" onClick={props.onClose}>Done</button>
        </div>
      </Show>
    </Modal>
  );
};

export default RedeemGrantModal;
