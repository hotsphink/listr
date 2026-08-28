import { createSignal, onCleanup } from "solid-js";
import jsQR from "jsqr";

/**
 * Shared camera + jsQR scanning loop (getUserMedia over a <video>, decoded
 * frame-by-frame onto a hidden <canvas>). Originally lived inline in
 * ScanShareModal.tsx (board/group share links); extracted so the join screen
 * (auth-design.md §7's guest-link flow) and any future QR consumer reuse the
 * same camera plumbing instead of a second copy of this loop (task explicitly
 * calls this out — ScanShareModal "already does jsqr over getUserMedia;
 * reuse it rather than writing a second scanner").
 *
 * Deliberately NOT tied to a Solid `createEffect` on some "open" prop the way
 * the original inline version was — start()/stop() are exposed instead, so
 * each caller decides when scanning should (re)start (e.g. ScanShareModal's
 * "Back" button restarts without the modal's `open` prop ever changing).
 * `videoRef`/`canvasRef` are accessor functions (not raw elements) because
 * Solid's `ref` callback populates its variable after the component body
 * runs, so the elements aren't available yet at hook-construction time.
 */
export function useQrScanner(opts: {
  videoRef: () => HTMLVideoElement | undefined;
  canvasRef: () => HTMLCanvasElement | undefined;
  /** Called once per frame a QR code is decoded from, however many times
   * that is (the same still-visible code every frame) — the caller decides
   * whether that's an accepted match (and should call `stop()`) or noise to
   * keep scanning through. */
  onDecode: (text: string) => void;
}) {
  const [cameraError, setCameraError] = createSignal<string | null>(null);
  // Bumped by every start()/stop(), so an in-flight getUserMedia() promise or
  // requestAnimationFrame loop from a previous session can recognize it's
  // stale and quietly stop touching state instead of racing a newer one.
  let generation = 0;
  let localStream: MediaStream | null = null;

  function stopStream(): void {
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    const v = opts.videoRef();
    if (v) v.srcObject = null;
  }

  function stop(): void {
    generation++;
    stopStream();
  }

  function start(): void {
    stop(); // only one session at a time
    const myGeneration = generation;
    setCameraError(null);

    const scan = () => {
      if (myGeneration !== generation) return;
      const videoRef = opts.videoRef();
      const canvasRef = opts.canvasRef();
      if (!videoRef || videoRef.readyState < videoRef.HAVE_ENOUGH_DATA) {
        requestAnimationFrame(scan);
        return;
      }
      const ctx = canvasRef?.getContext("2d", { willReadFrequently: true });
      if (!ctx || !canvasRef) { requestAnimationFrame(scan); return; }
      canvasRef.width = videoRef.videoWidth;
      canvasRef.height = videoRef.videoHeight;
      ctx.drawImage(videoRef, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvasRef.width, canvasRef.height);
      const code = jsQR(imageData.data, imageData.width, imageData.height);
      if (code) opts.onDecode(code.data);
      if (myGeneration === generation) requestAnimationFrame(scan);
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } } });
        if (myGeneration !== generation) { stream.getTracks().forEach((t) => t.stop()); return; }
        localStream = stream;
        const videoRef = opts.videoRef();
        if (!videoRef) return;
        videoRef.srcObject = stream;
        // Set muted as a DOM property — the HTML attribute alone is unreliable in Firefox.
        videoRef.muted = true;
        await videoRef.play();
        if (myGeneration !== generation) return;
        requestAnimationFrame(scan);
      } catch (e) {
        if (myGeneration === generation) setCameraError(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  onCleanup(stop);

  return { cameraError, start, stop };
}
