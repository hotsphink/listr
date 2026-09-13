/**
 * Sync-key generation. A sync key names a namespace on a server; who may use
 * one is decided by the server's user_keys table, reached through a grant.
 */

/** Generate a fresh random sync key, suitable for a new individual share or
 * board group. 16 bytes, or 128 bits. A sync key is sent in cleartext and the
 * server treats it as part of a user's identity-scoped key set, so anything
 * narrower is too weak. */
export function generateShareKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
