/**
 * Server-side half of the handshake's crypto: RFC 7638 JWK thumbprints, the
 * same signed-payload construction the client uses, and ECDSA signature
 * verification.
 *
 * This is an intentionally independent implementation of the algorithm in
 * packages/client/src/sync/clientIdentity.ts rather than an import of it. The
 * client module targets browser globals (`crypto.subtle`, `btoa`) while this
 * one runs in Node against `node:crypto`'s `webcrypto`, and the two packages
 * share no dependency edge. Both sides are independently tested against the
 * RFC 7638 test vector so they cannot silently drift apart. Change one and you
 * must change the other, then re-run both test suites.
 */
import { webcrypto } from "node:crypto";

export const AUTH_DOMAIN = "listr-auth-v1";

// Same registry as the client's clientIdentity.ts. See that file's comment for
// why only "EC" matters in production and the rest exist purely so the
// canonicalization can be checked against RFC 7638's published RSA vector.
const THUMBPRINT_MEMBERS: Record<string, readonly string[]> = {
  EC: ["crv", "kty", "x", "y"],
  RSA: ["e", "kty", "n"],
  oct: ["k", "kty"],
  OKP: ["crv", "kty", "x"],
};

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
  const digest = await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Buffer.from(digest).toString("base64url");
}

/** Identical construction to the client's buildAuthPayload. See that file's
 * comment for what each of the three bound values defends against. */
export function buildAuthPayload(serverId: string, nonce: string, clientId: string): Uint8Array {
  return new TextEncoder().encode(AUTH_DOMAIN + serverId + nonce + clientId);
}

/**
 * Verify an `auth` message's signature against the challenge this connection
 * issued. Returns false, and never throws, for any malformed input: a bad
 * curve name, a corrupt base64url signature, or a key that does not parse.
 * Every caller only cares about accept or reject, and `hello`'s
 * self-consistency check (client_id === thumbprint(pubkey_jwk)) has already
 * rejected a malformed client_id/pubkey_jwk pair.
 */
export async function verifyAuthSignature(
  pubkeyJwk: Record<string, unknown>,
  sigBase64Url: string,
  serverId: string,
  nonce: string,
  clientId: string,
): Promise<boolean> {
  try {
    const key = await webcrypto.subtle.importKey(
      "jwk",
      pubkeyJwk as webcrypto.JsonWebKey,
      { name: "ECDSA", namedCurve: (pubkeyJwk.crv as string) ?? "P-256" },
      false,
      ["verify"],
    );
    const sig = Buffer.from(sigBase64Url, "base64url");
    const payload = buildAuthPayload(serverId, nonce, clientId);
    return await webcrypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, payload);
  } catch {
    return false;
  }
}
