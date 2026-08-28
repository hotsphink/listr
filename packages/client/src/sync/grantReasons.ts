/**
 * Failure `reason`s the server can send back for `peek_grant`/`redeem_grant`/
 * `create_grant` (auth-design.md §6, job 3 scope A/B/D) — shared between
 * SyncClient's two consumers of this list:
 *
 * - EndpointConnection's generic `error` handling normally tears the whole
 *   connection down (§4.2's suspended/revoked/protocol/bad_signature are
 *   genuinely connection-fatal). A grant operation's failure is not: the
 *   whole point of parking a connection in "needs_grant" (or, for `share`,
 *   staying "ready") is that the join/grant UI can retry on the SAME
 *   connection without a reconnect. Reasons in this set are therefore
 *   forwarded to the UI instead of closing the socket.
 * - SyncClient's message router uses the same set to recognize which
 *   `error` replies belong to a pending grant operation (vs. some other kind
 *   of error) and hands them to the matching onGrantReply listener.
 *
 * Kept as one small shared list so the two call sites can't drift apart.
 */
export const GRANT_FAILURE_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "burned",
  "bad_secret",
  "expired",
  "used",
  "already_registered",
  "cap_denied",
  // Not a grant failure as such, but the same rule applies: a rejected
  // set_client_label is a UI-level error on a healthy connection and must
  // never tear the socket down.
  "bad_request",
]);
