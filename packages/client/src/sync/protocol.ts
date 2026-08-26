// Sync protocol version this client speaks. Sent to the server in the `hello`
// handshake. The server advertises a range of versions it understands and
// rejects the connection if this version falls outside that range.
//
// Bump this whenever the wire protocol changes in a way that is not backward
// compatible with older servers. Keep the server's supported range
// (packages/server/src/protocol.ts) in sync.
// v2: items switched from numeric `position` to `after_id` linked-list ordering.
// v3: multi-key sync — hello sends `keys[]`, push_entity/push_delete carry `sync_key`.
// v4: server-side user/key-group tracking. hello sends `default_key`; the server
// returns known keys via `ok.user_keys`; new `associate_key`/`leave_key` messages.
// v5: client-keypair identity + challenge/response handshake (auth-design.md
// §4). Flag day, same as v4's: hello drops `default_key` (identity is now the
// keypair; the home key comes back from the server) and gains `client_id`
// (RFC 7638 thumbprint) + `pubkey_jwk`. hello -> challenge -> auth -> ok now
// replaces hello -> ok directly; `variant` moves from `ok` to `challenge` so
// a dev/prod mismatch (§3.3) is caught before any crypto runs. See
// packages/server/src/protocol.ts for the full v4/v5 writeup.
export const PROTOCOL_VERSION = 5;
