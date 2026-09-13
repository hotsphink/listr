/**
 * Client identity crypto: RFC 7638 JWK thumbprints and the handshake's signing
 * payload.
 *
 * Pure, with no Dexie and no WebSocket, so it is unit-testable the same way
 * mergeLogic.ts is. The one platform dependency is Web Crypto's SubtleCrypto,
 * available both in the browser and, since Node 19, in vitest's "node" test
 * environment, so this needs no mocking to test. The non-extractable keypair
 * itself, including generation, storage, and signing, lives in clientKeys.ts,
 * which *does* touch Dexie and is deliberately kept separate so this file can
 * stay pure.
 *
 * The server holds its own independent copy of this same algorithm
 * (packages/server/src/authCrypto.ts) rather than importing this module, since
 * it runs in Node against `node:crypto`'s webcrypto, a different package with
 * its own type surface. Both sides are tested against the RFC 7638 vector so
 * they cannot silently drift apart.
 */

export const AUTH_DOMAIN = "listr-auth-v1";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** ArrayBuffer/Uint8Array -> unpadded base64url, the encoding used for both
 * JWK thumbprints and ECDSA signatures on the wire. */
export function base64UrlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 7638's registry of which JWK members are "required" per key type, which
// is exactly the set that goes into the canonical form. Anything else present
// on a real JWK (alg, key_ops, kid, ...) is excluded. Only "EC" is used in
// production, for P-256 client keys. The others are here only so
// canonicalJwkString can be validated against RFC 7638's own RSA test vector
// without a second implementation.
const THUMBPRINT_MEMBERS: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
  OKP: ["crv", "kty", "x"],
};

/**
 * RFC 7638 canonical JSON for a JWK's required members, lexicographically
 * ordered and with no whitespace, so an EC key serializes as exactly
 * `{"crv":...,"kty":"EC","x":...,"y":...}`. JS object key order for string
 * keys is insertion order, so assigning keys to `canonical` in sorted order
 * and letting JSON.stringify serialize it is sufficient, and no separate
 * serializer is needed.
 */
export function canonicalJwkString(jwk: Record<string, unknown>): string {
  const kty = jwk.kty as string | undefined;
  const members = (kty && THUMBPRINT_MEMBERS[kty]) ?? Object.keys(jwk);
  const sortedKeys = [...members].sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = jwk[k];
  return JSON.stringify(canonical);
}

/** RFC 7638 JWK thumbprint: base64url(SHA-256(canonical JWK)). */
export async function jwkThumbprint(jwk: Record<string, unknown>): Promise<string> {
  const canonical = canonicalJwkString(jwk);
  const digest = await crypto.subtle.digest("SHA-256", utf8(canonical) as BufferSource);
  return base64UrlFromBytes(digest);
}

/**
 * The exact bytes signed and verified in the handshake's `auth` step:
 * ECDSA-SHA256(privkey, "listr-auth-v1" || server_id || nonce || client_id).
 * Plain string concatenation is safe here because server_id, nonce, and
 * client_id are each fixed-shape opaque strings (a uuid, base64url random, and
 * a thumbprint), never attacker-chosen in a way that could exploit
 * concatenation ambiguity in this system's threat model.
 *
 * `server_id` binds the signature to one server, so a signature captured by
 * one server cannot be replayed against another. `nonce` kills replay across
 * connections and time. `client_id` ties the signature to the specific key
 * claiming it. Dropping any one of the three reopens exactly the attack it
 * exists to close.
 */
export function buildAuthPayload(serverId: string, nonce: string, clientId: string): Uint8Array {
  return utf8(AUTH_DOMAIN + serverId + nonce + clientId);
}
