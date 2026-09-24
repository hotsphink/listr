// Sync protocol version this client speaks. Sent to the server in the `hello`
// handshake. The server advertises a range of versions it understands and
// rejects the connection if this version falls outside that range.
//
// Bump this whenever the wire protocol changes in a way that is not backward
// compatible with older servers. Keep the server's supported range
// (packages/server/src/protocol.ts) in sync.
// v2: items switched from numeric `position` to `after_id` linked-list ordering.
// v3: multi-key sync. hello sends `keys[]`, and push_entity/push_delete carry `sync_key`.
// v4: server-side user/key-group tracking. hello sends `default_key`; the server
// returns known keys via `ok.user_keys`; new `associate_key`/`leave_key` messages.
// v5: client-keypair identity plus a challenge/response handshake. Flag day,
// the same as v4's: hello drops `default_key`, since identity is the keypair
// and the home key comes back from the server, and gains `client_id` (an RFC
// 7638 thumbprint) and `pubkey_jwk`. hello -> challenge -> auth -> ok replaces
// hello -> ok directly, and `variant` travels in `challenge` rather than `ok`,
// so a dev/prod mismatch is caught before any crypto runs. See
// packages/server/src/protocol.ts for the full v4/v5 writeup.
// v6: boards and lists carry `format` (doc/FORMAT.md) instead of
// `format_string` and `macros`. Flag day: the server converts stored rows in
// its migration 7, and older clients would otherwise overwrite them.
// v7: integration results are overlaid on items. `ok` lists the server's
// integration modules, results gain `choices` and `not_found`, and items gain
// `choices`. Additive: the server still accepts v6.
export const PROTOCOL_VERSION = 7;
