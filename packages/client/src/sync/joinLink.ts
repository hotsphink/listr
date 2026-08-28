/**
 * Join links (auth-design.md §7.2/§7.3a-bis): `#/j/<server-hash>/<grant_id>.<secret>`.
 *
 * The link carries a short hash of the server's *identity* (`server_id`),
 * never a route. A brand-new client resolves identity -> route locally:
 * hash matches the baked-in default -> connect there; matches a configured
 * endpoint -> use that endpoint's route; matches nothing -> say so and offer
 * to add a host. This is what lets the sender's route (their tailnet
 * address, say) differ from the recipient's (a public one) without the link
 * needing to know which.
 *
 * Pure: no Dexie, no WebSocket, no fetch — unit-testable the same way
 * clientIdentity.ts is. The one platform dependency is Web Crypto's
 * SubtleCrypto (for hashing server_id), available in both the browser and
 * vitest's node environment.
 */

import { base64UrlFromBytes } from "./clientIdentity.js";

/** §7.3a-bis: 6 base64url chars, ~36 bits — enough to name a target server,
 * not remotely enough to matter as a secret (the grant secret does that
 * job). Truncated SHA-256 of server_id. */
export const SERVER_HASH_LENGTH = 6;

async function utf8Digest(s: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** Short, stable hash of a server_id for embedding in a join link. */
export async function hashServerId(serverId: string): Promise<string> {
  const digest = await utf8Digest(serverId);
  return base64UrlFromBytes(digest).slice(0, SERVER_HASH_LENGTH);
}

export interface JoinLinkPayload {
  /** The server-identity hash from the link (§7.3a-bis) — resolved to a
   * route by the caller, never used as one. */
  serverHash: string;
  grantId: string;
  secret: string;
}

/**
 * Parse a join link's path segments (as delivered by the router at
 * `#/join/:hash/:credentials`) into a payload, or null if malformed.
 * `credentials` is `<grant_id>.<secret>` — the dot is unambiguous because
 * neither grantId (a UUID) nor secret (base64url) ever contains one.
 */
export function parseJoinPath(hash: string | undefined, credentials: string | undefined): JoinLinkPayload | null {
  if (!hash || !credentials) return null;
  const dot = credentials.indexOf(".");
  if (dot <= 0 || dot === credentials.length - 1) return null;
  const grantId = credentials.slice(0, dot);
  const secret = credentials.slice(dot + 1);
  if (!grantId || !secret) return null;
  // A stray second dot would make `secret` ambiguous with whatever follows —
  // reject rather than silently taking a truncated secret.
  if (secret.includes(".")) return null;
  return { serverHash: hash, grantId, secret };
}

/**
 * Parse a full join URL or a bare `<hash>/<grant_id>.<secret>` path fragment
 * — mirrors shareToken.ts's parseShareInput so manual paste / QR scan can
 * share one entry point regardless of exactly what was captured.
 */
export function parseJoinInput(raw: string): JoinLinkPayload | null {
  const s = raw.trim();
  const urlMatch = s.match(/#\/join\/([^/]+)\/([^/?#]+)/);
  if (urlMatch) return parseJoinPath(urlMatch[1], urlMatch[2]);

  const bareMatch = s.match(/^([^/]+)\/([^/?#]+)$/);
  if (bareMatch) return parseJoinPath(bareMatch[1], bareMatch[2]);

  return null;
}

/** Build the full join URL for a grant, using the current page as the base. */
export async function buildJoinUrl(serverId: string, grantId: string, secret: string): Promise<string> {
  const hash = await hashServerId(serverId);
  const base = window.location.href.split("#")[0];
  return `${base}#/join/${hash}/${grantId}.${secret}`;
}
