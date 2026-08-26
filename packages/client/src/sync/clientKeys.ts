/**
 * Client keypair generation, storage, and signing (auth-design.md §4.1, §8.1) —
 * the Dexie/WebCrypto-touching half of client identity. Kept separate from
 * clientIdentity.ts for unit testing without a Dexie/IndexedDB environment.
*/
import { db, type ClientIdentity } from "../db/database.js";
import { base64UrlFromBytes, jwkThumbprint } from "./clientIdentity.js";

let cached: ClientIdentity | null = null;
let inFlight: Promise<ClientIdentity> | null = null;

/**
 * Return this browser profile's client identity, generating and persisting a
 * fresh non-extractable P-256 keypair on first call. `privateKey` is created
 * with `extractable: false` and CryptoKey objects are structured-cloneable, so
 * Dexie stores them directly and the private key material is never accessible
 * to anything (§3.2, §4.1). `client_id` is the RFC 7638 thumbprint of the
 * public key, computed once here and cached on the row.
 *
 * Memoized in-process (module-level `cached`/`inFlight`) in addition to Dexie
 * so concurrent callers (e.g. two endpoints connecting at once) can't race and
 * generate two keypairs before the first write lands.
 */
export async function getOrCreateClientIdentity(): Promise<ClientIdentity> {
  if (cached) return cached;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const existing = await db.client_identity.get("default");
    if (existing) {
      cached = existing;
      return existing;
    }

    const keyPair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      /* extractable */ false,
      ["sign", "verify"],
    );
    const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
    const clientId = await jwkThumbprint(publicJwk as unknown as Record<string, unknown>);

    const identity: ClientIdentity = {
      id: "default",
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      client_id: clientId,
    };
    await db.client_identity.put(identity);
    cached = identity;
    return identity;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/** The public key as a JWK, ready to send in `hello`. Exporting a public key
 * needs no extractability (only the private half is restricted), so this is
 * cheap to call every time rather than caching the JWK form too. */
export async function exportPublicJwk(identity: ClientIdentity): Promise<Record<string, unknown>> {
  return (await crypto.subtle.exportKey("jwk", identity.publicKey)) as unknown as Record<string, unknown>;
}

/** Sign the v5 handshake's auth payload (§4.2) with this device's private
 * key, returning the signature as base64url, ready for the `auth` message. */
export async function signAuthPayload(identity: ClientIdentity, payload: Uint8Array): Promise<string> {
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, payload as BufferSource);
  return base64UrlFromBytes(sig);
}
