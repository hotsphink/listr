// Sync protocol version this client speaks. Sent to the server in the `hello`
// handshake. The server advertises a range of versions it understands and
// rejects the connection if this version falls outside that range.
//
// Bump this whenever the wire protocol changes in a way that is not backward
// compatible with older servers. Keep the server's supported range
// (packages/server/src/protocol.ts) in sync.
// v2: items switched from numeric `position` to `after_id` linked-list ordering.
// v3: multi-key sync — hello sends `keys[]`, push_entity/push_delete carry `sync_key`.
export const PROTOCOL_VERSION = 3;
