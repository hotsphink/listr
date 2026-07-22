export interface SharePayload {
  v: 1;
  sk: string;  // sync_key
  bid: string; // board id
  bn: string;  // board name (display hint)
}

/** Encode a share payload as a URL-safe base64 token. */
export function encodeShareToken(payload: SharePayload): string {
  // encodeURIComponent before btoa so non-ASCII board names survive
  return btoa(encodeURIComponent(JSON.stringify(payload)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a token back to a payload, or return null on any failure. */
export function decodeShareToken(token: string): SharePayload | null {
  try {
    const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const obj = JSON.parse(decodeURIComponent(atob(b64)));
    if (obj.v === 1 && typeof obj.sk === "string" && obj.sk) return obj as SharePayload;
  } catch { /* ignore */ }
  return null;
}

/** Build the full share URL for a payload, using the current page as the base. */
export function makeShareUrl(payload: SharePayload): string {
  const base = window.location.href.split("#")[0];
  return `${base}#/receive/${encodeShareToken(payload)}`;
}

/**
 * Parse whatever the user pasted or the QR scanner found into a SharePayload.
 * Accepts: full share URL, bare base64 token, raw JSON (legacy), bare hex key.
 */
export function parseShareInput(raw: string): SharePayload | null {
  const s = raw.trim();

  // Full share URL containing #/receive/<token>
  const urlMatch = s.match(/#\/receive\/([A-Za-z0-9_=-]+)/);
  if (urlMatch) return decodeShareToken(urlMatch[1]);

  // Bare token (no URL wrapper)
  const tokenResult = decodeShareToken(s);
  if (tokenResult) return tokenResult;

  // Legacy raw JSON from old QR codes
  try {
    const obj = JSON.parse(s);
    if (obj.v === 1 && typeof obj.sk === "string" && obj.sk) return obj as SharePayload;
  } catch { /* not JSON */ }

  // Bare hex sync key — synthesise a minimal payload
  if (/^[a-f0-9]{8,}$/i.test(s)) return { v: 1, sk: s, bid: "", bn: "" };

  return null;
}
