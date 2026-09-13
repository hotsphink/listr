/**
 * Join links: `#/j/<server-hash>/<grant_id>.<secret>`.
 *
 * The link carries a short hash of the server's *identity* (`server_id`),
 * never a route. A brand-new client resolves identity -> route locally:
 * hash matches the baked-in default -> connect there; matches a configured
 * endpoint -> use that endpoint's route; matches nothing -> say so and offer
 * to add a host. This is what lets the sender's route (their tailnet
 * address, say) differ from the recipient's (a public one) without the link
 * needing to know which.
 *
 * Pure, with no Dexie, no WebSocket, and no fetch, so it is unit-testable the
 * same way clientIdentity.ts is. The one platform dependency is Web Crypto's
 * SubtleCrypto (for hashing server_id), available in both the browser and
 * vitest's node environment.
 */

import { base64UrlFromBytes } from "./clientIdentity.js";

/** 6 base64url chars, roughly 36 bits: enough to name a target server, and
 * nowhere near enough to matter as a secret, which is the grant secret's job.
 * Truncated SHA-256 of server_id. */
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
  /** The server-identity hash from the link. The caller resolves it to a
   * route; it is never used as one. */
  serverHash: string;
  grantId: string;
  secret: string;
}

/** A parsed join link plus the optional board id its query string carries. */
export interface ParsedJoinLink extends JoinLinkPayload {
  /** Board to open once the join completes, from `?b=`. Absent on a group
   * share, which has no single board to land on, and on a plain invite. */
  boardId?: string;
}

/** Query-string key naming the board a share link points at. */
const BOARD_PARAM = "b";

function boardIdFromQuery(query: string | undefined): string | undefined {
  if (!query) return undefined;
  const value = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query).get(BOARD_PARAM);
  return value || undefined;
}

function withBoardId(base: JoinLinkPayload | null, query: string | undefined): ParsedJoinLink | null {
  if (!base) return null;
  const boardId = boardIdFromQuery(query);
  return boardId ? { ...base, boardId } : base;
}

/**
 * Parse a join link's path segments (as delivered by the router at
 * `#/join/:hash/:credentials`) into a payload, or null if malformed.
 * `credentials` is `<grant_id>.<secret>`. The dot is unambiguous because
 * neither grantId, a UUID, nor secret, base64url, ever contains one.
 */
export function parseJoinPath(hash: string | undefined, credentials: string | undefined): JoinLinkPayload | null {
  if (!hash || !credentials) return null;
  const dot = credentials.indexOf(".");
  if (dot <= 0 || dot === credentials.length - 1) return null;
  const grantId = credentials.slice(0, dot);
  const secret = credentials.slice(dot + 1);
  if (!grantId || !secret) return null;
  // A stray second dot would make `secret` ambiguous with whatever follows,
  // so reject rather than silently taking a truncated secret.
  if (secret.includes(".")) return null;
  return { serverHash: hash, grantId, secret };
}

/**
 * Parse a full join URL or a bare `<hash>/<grant_id>.<secret>` path fragment,
 * so a manual paste and a QR scan share one entry point regardless of exactly
 * what was captured.
 */
export function parseJoinInput(raw: string): ParsedJoinLink | null {
  const s = raw.trim();
  const urlMatch = s.match(/#\/join\/([^/]+)\/([^/?#]+)(\?[^#]*)?/);
  if (urlMatch) return withBoardId(parseJoinPath(urlMatch[1], urlMatch[2]), urlMatch[3]);

  const bareMatch = s.match(/^([^/]+)\/([^/?#]+)(\?[^#]*)?$/);
  if (bareMatch) return withBoardId(parseJoinPath(bareMatch[1], bareMatch[2]), bareMatch[3]);

  return null;
}

/**
 * The router path for a parsed link, so a scanner can hand a scanned link
 * straight to JoinPage rather than reimplementing any of its resolution.
 */
export function joinRoutePath(link: ParsedJoinLink): string {
  const query = link.boardId ? `?${BOARD_PARAM}=${encodeURIComponent(link.boardId)}` : "";
  return `/join/${link.serverHash}/${link.grantId}.${link.secret}${query}`;
}

/**
 * Build the full join URL for a grant, using the current page as the base.
 * `boardId` names the board to open once the join lands, for a share link
 * pointing at one specific board.
 */
export async function buildJoinUrl(
  serverId: string,
  grantId: string,
  secret: string,
  boardId?: string,
): Promise<string> {
  const hash = await hashServerId(serverId);
  const base = window.location.href.split("#")[0];
  const query = boardId ? `?${BOARD_PARAM}=${encodeURIComponent(boardId)}` : "";
  return `${base}#/join/${hash}/${grantId}.${secret}${query}`;
}
