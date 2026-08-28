import { describe, it, expect } from "vitest";
import { AUTH_DOMAIN, base64UrlFromBytes, buildAuthPayload, canonicalJwkString, jwkThumbprint } from "./clientIdentity.js";

// The RFC 7638 worked example, the same RSA key used across several JOSE RFCs
// (7515, 7517, 7638). Included so the shared canonicalize, hash, and base64url
// pipeline is checked against a value this module did not produce itself, even
// though production only ever exercises the "EC" branch.
const RFC7638_RSA_JWK = {
  kty: "RSA",
  n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
  e: "AQAB",
  alg: "RS256",
  kid: "2011-04-29",
};
const RFC7638_EXPECTED_THUMBPRINT = "NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs";

describe("canonicalJwkString", () => {
  it("keeps only the required members, sorted, with no whitespace (RFC 7638 RSA example)", () => {
    expect(canonicalJwkString(RFC7638_RSA_JWK)).toBe(
      `{"e":"AQAB","kty":"RSA","n":"${RFC7638_RSA_JWK.n}"}`,
    );
  });

  it("produces the exact EC canonical form the handshake specifies", () => {
    const jwk = { kty: "EC", crv: "P-256", x: "x-coord", y: "y-coord", extra: "dropped" };
    expect(canonicalJwkString(jwk)).toBe('{"crv":"P-256","kty":"EC","x":"x-coord","y":"y-coord"}');
  });
});

describe("jwkThumbprint", () => {
  it("matches the published RFC 7638 test vector", async () => {
    expect(await jwkThumbprint(RFC7638_RSA_JWK)).toBe(RFC7638_EXPECTED_THUMBPRINT);
  });

  it("is deterministic and order-independent in the source object's key order", async () => {
    const a = { kty: "EC", crv: "P-256", x: "abc", y: "def" };
    const b = { y: "def", x: "abc", crv: "P-256", kty: "EC" };
    expect(await jwkThumbprint(a)).toBe(await jwkThumbprint(b));
  });

  it("changes if the public key coordinates change", async () => {
    const a = await jwkThumbprint({ kty: "EC", crv: "P-256", x: "abc", y: "def" });
    const b = await jwkThumbprint({ kty: "EC", crv: "P-256", x: "abc", y: "ZZZ" });
    expect(a).not.toBe(b);
  });

  it("ignores non-canonical members like alg/kid/key_ops", async () => {
    const a = await jwkThumbprint({ kty: "EC", crv: "P-256", x: "abc", y: "def" });
    const b = await jwkThumbprint({ kty: "EC", crv: "P-256", x: "abc", y: "def", alg: "ES256", key_ops: ["verify"] });
    expect(a).toBe(b);
  });
});

describe("base64UrlFromBytes", () => {
  it("is unpadded and URL-safe (no +, /, or =)", () => {
    // 0xff 0xff 0xff base64s to "////" with the standard alphabet, a good
    // probe for the -/_ substitution actually firing.
    const out = base64UrlFromBytes(new Uint8Array([0xff, 0xff, 0xff]));
    expect(out).toBe("____");
    expect(out).not.toMatch(/[+/=]/);
  });
});

describe("buildAuthPayload", () => {
  it("concatenates the domain separator, server_id, nonce, and client_id", () => {
    const payload = buildAuthPayload("srv1", "nonce1", "client1");
    expect(new TextDecoder().decode(payload)).toBe(`${AUTH_DOMAIN}srv1nonce1client1`);
  });

  it("differs when server_id changes, holding nonce and client_id fixed", () => {
    // This is the property that stops a signature captured by one server from
    // being replayed against another. Changing server_id alone must change
    // every byte from that point on, so a signature valid for server A can
    // never verify for server B, even if by some vanishingly unlikely
    // coincidence both issued the exact same nonce to the exact same
    // client_id. A true black-box WS test of this scenario would require
    // forcing a 128-bit nonce collision across two independent server
    // processes, which is not practically constructible. See index.test.ts's
    // "nonce bound to a different server_id" test for the WS-level
    // approximation and a note on this gap.
    const a = buildAuthPayload("serverA", "same-nonce", "same-client");
    const b = buildAuthPayload("serverB", "same-nonce", "same-client");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("differs when the nonce changes, holding server_id and client_id fixed", () => {
    const a = buildAuthPayload("srv", "nonceA", "client");
    const b = buildAuthPayload("srv", "nonceB", "client");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("differs when client_id changes, holding server_id and nonce fixed", () => {
    const a = buildAuthPayload("srv", "nonce", "clientA");
    const b = buildAuthPayload("srv", "nonce", "clientB");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
