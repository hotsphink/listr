import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";
import { AUTH_DOMAIN, buildAuthPayload, canonicalJwkString, jwkThumbprint, verifyAuthSignature } from "./authCrypto.js";

// The same RFC 7638 worked example as the client's clientIdentity.test.ts,
// kept identical on both sides so a fixed external vector, and not just mutual
// agreement, is what gets checked.
const RFC7638_RSA_JWK = {
  kty: "RSA",
  n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
  alg: "RS256",
  kid: "2011-04-29",
};
const RFC7638_EXPECTED_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

describe("canonicalJwkString (server side)", () => {
  it("matches the RFC 7638 RSA example", () => {
    expect(canonicalJwkString(RFC7638_RSA_JWK)).toBe(
      `{"e":"AQAB","kty":"RSA","n":"${RFC7638_RSA_JWK.n}"}`,
    );
  });
});

describe("jwkThumbprint (server side)", () => {
  it("matches the published RFC 7638 test vector", async () => {
    expect(await jwkThumbprint(RFC7638_RSA_JWK)).toBe(RFC7638_EXPECTED_THUMBPRINT);
  });
});

describe("buildAuthPayload (server side)", () => {
  it("matches the client's byte-for-byte construction", () => {
    const payload = buildAuthPayload("srv1", "nonce1", "client1");
    expect(Buffer.from(payload).toString("utf8")).toBe(`${AUTH_DOMAIN}srv1nonce1client1`);
  });
});

async function generateP256(): Promise<{ jwk: Record<string, unknown>; privateKey: CryptoKey }> {
  const kp = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", kp.publicKey);
  return { jwk: jwk as unknown as Record<string, unknown>, privateKey: kp.privateKey };
}

async function sign(privateKey: CryptoKey, serverId: string, nonce: string, clientId: string): Promise<string> {
  const payload = buildAuthPayload(serverId, nonce, clientId);
  const sig = await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, payload);
  return Buffer.from(sig).toString("base64url");
}

describe("verifyAuthSignature", () => {
  it("accepts a correctly signed payload", async () => {
    const { jwk, privateKey } = await generateP256();
    const clientId = await jwkThumbprint(jwk);
    const sig = await sign(privateKey, "server-1", "nonce-1", clientId);
    expect(await verifyAuthSignature(jwk, sig, "server-1", "nonce-1", clientId)).toBe(true);
  });

  it("rejects a signature from the wrong key", async () => {
    const { jwk } = await generateP256();
    const other = await generateP256();
    const clientId = await jwkThumbprint(jwk);
    const sig = await sign(other.privateKey, "server-1", "nonce-1", clientId);
    expect(await verifyAuthSignature(jwk, sig, "server-1", "nonce-1", clientId)).toBe(false);
  });

  it("rejects the same signature replayed against a different server_id, the cross-server replay case", async () => {
    const { jwk, privateKey } = await generateP256();
    const clientId = await jwkThumbprint(jwk);
    // Signed for server A...
    const sig = await sign(privateKey, "server-A", "nonce-1", clientId);
    // ...must not verify for server B, even with the identical nonce and
    // client_id. That property is what makes it safe to bind server_id into
    // the payload rather than relying solely on nonce uniqueness. A true
    // black-box WS reproduction would need two independent server processes to
    // issue the exact same 128-bit random nonce, which is not practically
    // constructible, so this is tested directly at the signature layer. See
    // index.test.ts for the WS-level approximation, where a foreign or
    // unrecognized nonce is rejected.
    expect(await verifyAuthSignature(jwk, sig, "server-B", "nonce-1", clientId)).toBe(false);
  });

  it("rejects a signature whose nonce doesn't match", async () => {
    const { jwk, privateKey } = await generateP256();
    const clientId = await jwkThumbprint(jwk);
    const sig = await sign(privateKey, "server-1", "nonce-1", clientId);
    expect(await verifyAuthSignature(jwk, sig, "server-1", "nonce-2", clientId)).toBe(false);
  });

  it("rejects a malformed signature without throwing", async () => {
    const { jwk } = await generateP256();
    const clientId = await jwkThumbprint(jwk);
    expect(await verifyAuthSignature(jwk, "not-a-real-signature", "server-1", "nonce-1", clientId)).toBe(false);
  });
});
