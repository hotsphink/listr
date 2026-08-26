/**
 * Client identity crypto — RFC 7638 JWK thumbprints and the v5 handshake's
 * signing payload (auth-design.md §4.1/§4.2).
 *
 * Pure: no Dexie, no WebSocket — unit-testable the same way mergeLogic.ts
 * is. The one platform dependency is Web Crypto's SubtleCrypto, available
 * both in the browser and (since Node 19) in vitest's "node" test
 * environment, so this needs no mocking to test. The non-extractable
 * keypair itself — generation, storage, signing — lives in clientKeys.ts,
 * which *does* touch Dexie and is deliberately kept separate so this file
 * can stay pure.
 *
 * The server has its own independent copy of this same algorithm
 * (packages/server/src/authCrypto.ts) rather than importing this module —
 * it runs in Node against `node:crypto`'s webcrypto, a different package
 * with its own type surface. Both sides are tested against the RFC 7638
 * vector so they can't silently drift apart.
 */

export const AUTH_DOMAIN = "listr-auth-v1";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** ArrayBuffer/Uint8Array -> unpadded base64url, the encoding used for both
 * JWK thumbprints and ECDSA signatures on the wire (matches the pattern
 * shareToken.ts already uses for its own base64url encoding). */
export function base64UrlFromBytes(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// RFC 7638 §3.2's registry of which JWK members are "required" per key type,
// i.e. exactly the members that go into the canonical form — anything else
// present on a real JWK (alg, key_ops, kid, ...) is excluded. Only "EC" is
// actually used in production (P-256 client keys); the others are here only
// so canonicalJwkString can be validated against RFC 7638's own (RSA) test
// vector without a second implementation.
const THUMBPRINT_MEMBERS: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
  OKP: ["crv", "kty", "x"],
};

/**
 * RFC 7638 canonical JSON for a JWK's required members, lexicographically
 * ordered and with no whitespace — e.g. for an EC key exactly
 * `{"crv":...,"kty":"EC","x":...,"y":...}` (§4.1). JS object key order for
 * string keys is insertion order, so building `canonical` by assigning keys
 * in sorted order and letting JSON.stringify serialize it is sufficient —
 * no separate serializer needed.
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
 * The exact bytes signed and verified in the v5 handshake's `auth` step
 * (§4.2): ECDSA-SHA256(privkey, "listr-auth-v1" || server_id || nonce ||
 * client_id). Plain string concatenation, per the design doc — server_id,
 * nonce, and client_id are each fixed-shape opaque strings (uuid / base64url
 * random / thumbprint), not attacker-chosen in a way that could exploit
 * concatenation ambiguity in this system's threat model.
 *
 * `server_id` binds the signature to one server (so a signature captured by
 * one server can't be replayed against another); `nonce` kills replay across
 * connections/time; `client_id` ties it to the specific key claiming it.
 * Dropping any one of the three would reopen exactly the attack it exists to
 * close — see the design doc's §4.2 notes.
 */
export function buildAuthPayload(serverId: string, nonce: string, clientId: string): Uint8Array {
  return utf8(AUTH_DOMAIN + serverId + nonce + clientId);
}
